import type { FlushResult } from "../../packages/types/lifecycle";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
  JoinLogDiskMessage,
  JoinLogPersistedReply,
} from "../../packages/types/diskIO";
import { JOIN_LOG_MAX_BUFFERED_ENTRIES } from "../../packages/consts/diskIO/joinLog";

/**
 * 入群事实的主线程入口（packages/infra/joinLog.ts）。
 *
 * 它的返回值直接决定 antiRaid/updateIngress.ts 抛不抛错：受理即放行 update，未确认
 * 镜像满或 Disk I/O 拒收时让 update 失败重投。落盘确认改由 joinLogPersisted 水位
 * 释放镜像，Worker 重建时镜像原序重放。
 */

const postDiskIO = mock((_message: DiskBusinessMessage): boolean => true);
const flushDiskIODomain = mock(async (): Promise<FlushResult> => "flushed");
let persistedListener: ((reply: JoinLogPersistedReply) => void) | undefined;
let respawnListener: DiskIORespawnListener | undefined;

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO,
  flushDiskIODomain,
  onDiskIOReply: diskIOReplyStub({
    joinLogPersisted: (listener: (reply: JoinLogPersistedReply) => void): void => {
      persistedListener = listener;
    },
  }),
  onDiskIORespawn: (_owner: string, _priority: number, listener: DiskIORespawnListener): void => {
    respawnListener = listener;
  },
})));

const { purgeChatJoinLog, recordJoinLog } = await import("../../packages/infra/joinLog");
const { teardownRegisteredChat } = await import("../../packages/infra/chatTeardownRegistry");
const { unacknowledgedJoinLogs } = await import("../../packages/cache/main/joinLog");

const PARAMS = { chatId: -1001, userId: 42, joinedAt: 1_753_000_000_000 };

function mirrored(): JoinLogDiskMessage[] {
  return [...unacknowledgedJoinLogs.values()];
}

function acknowledge(through: number, pending: readonly number[] = []): void {
  if (persistedListener === undefined) throw new Error("joinLogPersisted listener was not registered.");
  persistedListener({ type: "joinLogPersisted", through, pending });
}

async function replay(): Promise<DiskBusinessMessage[]> {
  if (respawnListener === undefined) throw new Error("Join log respawn listener was not registered.");
  const replayed: DiskBusinessMessage[] = [];
  const transport: DiskIORecoveryTransport = {
    post: (message: DiskBusinessMessage): boolean => {
      replayed.push(message);
      return true;
    },
    ensureLuckReceiptSecret: async (): Promise<never> => {
      throw new Error("Join log replay must not request luck secrets.");
    },
  };
  expect(await respawnListener(transport)).toBeTrue();
  return replayed;
}

beforeEach(() => {
  postDiskIO.mockClear();
  flushDiskIODomain.mockClear();
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIODomain.mockImplementation(async (): Promise<FlushResult> => "flushed");
  unacknowledgedJoinLogs.clear();
});

describe("recordJoinLog 的受理与未确认镜像", () => {
  test("投递带递增序号的事实并登记镜像，不等待任何 flush", () => {
    expect(recordJoinLog(PARAMS)).toBeTrue();
    expect(recordJoinLog({ ...PARAMS, userId: 43 })).toBeTrue();

    const posted: JoinLogDiskMessage[] = postDiskIO.mock.calls.map(
      ([message]: [DiskBusinessMessage]): JoinLogDiskMessage => message as JoinLogDiskMessage
    );
    expect(posted).toHaveLength(2);
    expect(posted[1]!.sequence).toBe(posted[0]!.sequence + 1);
    expect(posted[0]).toMatchObject({ type: "joinLog", ...PARAMS, day: "2025-07-20" });
    expect(mirrored()).toEqual(posted);
    expect(flushDiskIODomain).not.toHaveBeenCalled();
  });

  test("投递本身被拒时报失败，且不登记镜像", () => {
    postDiskIO.mockImplementation((): boolean => false);

    expect(recordJoinLog(PARAMS)).toBeFalse();
    expect(mirrored()).toHaveLength(0);
  });

  test("镜像达到上限时快速失败，不再投递，让这条 update 重投", () => {
    for (let index: number = 0; index < JOIN_LOG_MAX_BUFFERED_ENTRIES; index++) {
      expect(recordJoinLog({ ...PARAMS, userId: index + 1 })).toBeTrue();
    }
    postDiskIO.mockClear();

    expect(recordJoinLog(PARAMS)).toBeFalse();
    expect(postDiskIO).not.toHaveBeenCalled();
    expect(mirrored()).toHaveLength(JOIN_LOG_MAX_BUFFERED_ENTRIES);
  });

  test("待写列表为空时只释放不超过 through 的前缀", () => {
    recordJoinLog(PARAMS);
    recordJoinLog({ ...PARAMS, userId: 43 });
    recordJoinLog({ ...PARAMS, userId: 44 });
    const [first, second, third] = mirrored();

    acknowledge(second!.sequence);

    expect(mirrored()).toEqual([third!]);
    acknowledge(first!.sequence);
    expect(mirrored()).toEqual([third!]);
  });

  test("回执里的待写序号留在镜像，其余已处置的事实照常释放", () => {
    for (let userId: number = 1; userId <= 4; userId++) recordJoinLog({ ...PARAMS, userId });
    const [, second, third, fourth] = mirrored();

    // 一个群的文件写不进只留下它自己的事实，不挡住其它群。
    acknowledge(third!.sequence, [second!.sequence]);

    expect(mirrored()).toEqual([second!, fourth!]);
    acknowledge(fourth!.sequence);
    expect(mirrored()).toEqual([]);
  });

  test("Worker 重建时原序重放全部未确认事实", async () => {
    recordJoinLog(PARAMS);
    recordJoinLog({ ...PARAMS, userId: 43 });
    const pending: JoinLogDiskMessage[] = mirrored();

    expect(await replay()).toEqual(pending);
    // 重放不释放镜像：释放只认新 Worker 的水位回执。
    expect(mirrored()).toEqual(pending);
  });
});

/**
 * 群 teardown 的整群删除。它是 `/init disable` 与离群这两条路上唯一会动
 * `memory/joinlog/` 的入口；不删的话，一个已经不再接管的群的成员名单会一直躺在
 * 那里，直到保留窗口自然过期。
 */
describe("purgeChatJoinLog 的整群删除", () => {
  test("投递删除并以 joinLogPurge 领域的 flush 回执为准", async () => {
    await purgeChatJoinLog(-1001);

    expect(postDiskIO).toHaveBeenCalledWith({ type: "deleteJoinLog", chatId: -1001 });
    // 等的是删除那一格：屏障只刷这一个领域，不牵动其它群的入群批次。
    expect(flushDiskIODomain).toHaveBeenCalledWith("joinLogPurge");
  });

  test("删除接管该群的未确认事实，Worker 重建时不再把它们写回", async () => {
    recordJoinLog(PARAMS);
    recordJoinLog({ ...PARAMS, chatId: -1002 });
    recordJoinLog({ ...PARAMS, userId: 43 });
    const other: JoinLogDiskMessage = mirrored()[1]!;

    await purgeChatJoinLog(-1001);

    expect(mirrored()).toEqual([other]);
    expect(await replay()).toEqual([other]);
  });

  test("投递被拒时上抛，且不再问 flush", async () => {
    postDiskIO.mockImplementation((): boolean => false);

    await expect(purgeChatJoinLog(-1001)).rejects.toThrow("refused the join log deletion");
    expect(flushDiskIODomain).not.toHaveBeenCalled();
  });

  test("没落盘就上抛，不把日志还在报成删干净了", async () => {
    flushDiskIODomain.mockImplementation(async (): Promise<FlushResult> => "failed");

    await expect(purgeChatJoinLog(-1001)).rejects.toThrow("Failed to delete the join logs");
  });

  test("teardown owner 只在要删数据的两条路上发出删除，失权停管一条都不发", async () => {
    await teardownRegisteredChat("joinLog", -1001, "explicitDisable");
    await teardownRegisteredChat("joinLog", -1001, "departed");
    expect(postDiskIO).toHaveBeenCalledTimes(2);

    postDiskIO.mockClear();
    await teardownRegisteredChat("joinLog", -1001, "lostAuthority");
    expect(postDiskIO).not.toHaveBeenCalled();
  });
});
