import type { FlushResult } from "../../packages/types/lifecycle";
import { diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiskBusinessMessage } from "../../packages/types/diskIO";

/**
 * 入群事实的 durable 屏障（packages/infra/joinLog.ts）。
 *
 * 它的返回值直接决定 antiRaid/updateIngress.ts 抛不抛错，而那条错误会一路
 * 经 bot.catch rethrow 让 handleUpdate reject，最终使 ApplicationLifecycle.run("main")
 * 非零退出并扣住最终 offset——Telegram 会把上次确认点之后的全部更新重投一遍。
 * 因此「已缓冲待写」必须与「写入失败」分开报。
 */

const postDiskIO = mock((_message: DiskBusinessMessage): boolean => true);
const flushDiskIODomain = mock(async (): Promise<FlushResult> => "flushed");
let buffering: boolean = false;

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO,
  flushDiskIODomain,
  isDiskIOBuffering: (): boolean => buffering,
})));

const { purgeChatJoinLog, recordJoinLog } = await import("../../packages/infra/joinLog");
const { teardownRegisteredChat } = await import("../../packages/infra/chatTeardownRegistry");

const PARAMS = { chatId: -1001, userId: 42, joinedAt: 1_753_000_000_000 };

beforeEach(() => {
  postDiskIO.mockClear();
  flushDiskIODomain.mockClear();
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIODomain.mockImplementation(async (): Promise<FlushResult> => "flushed");
  buffering = false;
});

describe("recordJoinLog 的 durable 屏障", () => {
  test("正常可写时以 joinLog 领域的 flush 回执为准", async () => {
    await expect(recordJoinLog(PARAMS)).resolves.toBeTrue();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(flushDiskIODomain).toHaveBeenCalledWith("joinLog");
  });

  test("可写时真的没写进去就报失败，让这条 update 重投", async () => {
    flushDiskIODomain.mockImplementation(async (): Promise<FlushResult> => "failed");

    await expect(recordJoinLog(PARAMS)).resolves.toBeFalse();
  });

  test("投递本身被拒时直接失败，不再问 flush", async () => {
    postDiskIO.mockImplementation((): boolean => false);

    await expect(recordJoinLog(PARAMS)).resolves.toBeFalse();
    expect(flushDiskIODomain).not.toHaveBeenCalled();
  });

  test("恢复握手期已进缓冲即算受理：不问 flush，也不把瞬时故障放大成进程退出", async () => {
    // 这段窗口里没有可写的 Worker，requestDiskIOFlush 会直接短路成 "failed"
    // ——那是「此刻没人能刷盘」，不是「写坏了」。消息已经在有硬顶的 FIFO 里排着，
    // 握手结束后由 activateDiskIOWorker 原序重放；重放失败或缓冲触顶都走
    // stopWorkerAfterLoadFailure 的统一 fatal，事实不会被静默丢掉。
    buffering = true;
    flushDiskIODomain.mockImplementation(async (): Promise<FlushResult> => "failed");

    await expect(recordJoinLog(PARAMS)).resolves.toBeTrue();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(flushDiskIODomain).not.toHaveBeenCalled();
  });

  test("恢复握手期缓冲触顶被拒时照样报失败", async () => {
    buffering = true;
    postDiskIO.mockImplementation((): boolean => false);

    await expect(recordJoinLog(PARAMS)).resolves.toBeFalse();
  });
});

/**
 * 群 teardown 的整群删除。它是 `/init disable` 与离群这两条路上唯一会动
 * `memory/joinlog/` 的入口；不删的话，一个已经不再接管的群的成员名单会一直躺在
 * 那里，直到保留窗口自然过期。
 */
describe("purgeChatJoinLog 的整群删除", () => {
  test("投递删除并以 joinLog 领域的 flush 回执为准", async () => {
    await purgeChatJoinLog(-1001);

    expect(postDiskIO).toHaveBeenCalledWith({ type: "deleteJoinLog", chatId: -1001 });
    // 等的是删除那一格：删不掉的文件不得让每一条入群事实的屏障一起报失败。
    expect(flushDiskIODomain).toHaveBeenCalledWith("joinLogPurge");
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
