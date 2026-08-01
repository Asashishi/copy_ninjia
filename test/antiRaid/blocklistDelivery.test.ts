import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../packages/types/blocklist";

/**
 * 投递前的 durable 对账（antiRaid/blocklistDelivery.ts）：处置消息在 outbox flush
 * 的等待期里仍可能被并发的 `/unblock` 取消，而黑名单成员入群那一路的处置是
 * **取代** join 投递的——两件事撞在一起就会让这个人既没有移除、也没有验证窗口。
 */
const errorLogs: string[] = [];
const requestBlocklistResweep = mock((_chatId: number): void => {});
const persistPendingBlockedRemovals = mock(async (): Promise<void> => {});
let authoritative = new Map<number, RemoveBlockedMembersParams>();

mock.module("../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));
mock.module("../../packages/infra/blocklist/outbox", () => ({
  getPendingBlockedRemovalParams: (removalId: number): RemoveBlockedMembersParams | undefined => {
    const params: RemoveBlockedMembersParams | undefined = authoritative.get(removalId);
    return params === undefined ? undefined : { ...params, userIds: [...params.userIds] };
  },
  persistPendingBlockedRemovals,
}));
mock.module("../../packages/infra/blocklist/sweep", () => ({ requestBlocklistResweep }));

const { prepareDurableAntiRaidMessages } =
  await import("../../packages/antiRaid/blocklistDelivery");

const removal: AntiRaidWorkerMessage = {
  type: "removeBlockedMembers",
  chatId: -1001,
  userIds: [42],
  probeMembership: false,
  removalId: 7,
};
const replacedJoin: AntiRaidWorkerMessage = {
  type: "join",
  chatId: -1001,
  member: { id: 42, first_name: "Joiner" },
  actorIsWhitelisted: false,
};

beforeEach(() => {
  errorLogs.length = 0;
  requestBlocklistResweep.mockClear();
  persistPendingBlockedRemovals.mockClear();
  authoritative = new Map([[7, { chatId: -1001, userIds: [42], probeMembership: false, removalId: 7 }]]);
});

describe("黑名单处置投递前的 durable 对账", () => {
  test("批次仍在权威镜像里时按镜像重建，不动兜底 join", async () => {
    const result = await prepareDurableAntiRaidMessages([removal], new Map([[7, replacedJoin]]));
    expect(result).toEqual([removal]);
  });

  test("批次在等待期里被取消时补投它取代掉的那条 join", async () => {
    // claimBlockedJoiner 对黑名单成员刻意不投 join——Worker 不会为一个马上要被
    // 踢掉的人开窗口。flush 等待期里并发的 /unblock 把这批处置整批删掉之后，
    // 不补 join 的话这个人既没有移除、也没有验证窗口：没有提醒、没有超时踢人，
    // 就这么留在群里，而系统里再没有任何一处会为他重新开一个。
    authoritative.clear();

    const result = await prepareDurableAntiRaidMessages([removal], new Map([[7, replacedJoin]]));

    expect(result).toEqual([replacedJoin]);
  });

  test("没有被取代的 join 时（补扫/广告处置那一路）取消就是单纯摘掉", async () => {
    authoritative.clear();
    const result = await prepareDurableAntiRaidMessages([removal], new Map());
    expect(result).toEqual([]);
  });

  test("补扫的现算名单不参与对账比较：落盘窗口里有人被拉黑不该白烧轮次", async () => {
    // 补扫的名单不进 outbox，durable 的只有任务本身。拿现算结果去比，等落盘的
    // 那几毫秒里随便一次 /block 或广告处置命中都会判成「内容变了」再来一轮，
    // 连着变几次就把一次完全合法的补扫整个 withheld 掉。
    const sweep: AntiRaidWorkerMessage = {
      type: "removeBlockedMembers",
      chatId: -1001,
      userIds: [42],
      probeMembership: true,
      removalId: 7,
    };
    let blocked: number[] = [42];
    authoritative = {
      get: (removalId: number): RemoveBlockedMembersParams | undefined =>
        removalId === 7
          ? { chatId: -1001, userIds: [...blocked], probeMembership: true, removalId: 7 }
          : undefined,
    } as Map<number, RemoveBlockedMembersParams>;
    // 第一次落盘之后名单又多了一个人。
    persistPendingBlockedRemovals.mockImplementationOnce(async (): Promise<void> => {
      blocked = [42, 43];
    });

    const result = await prepareDurableAntiRaidMessages([sweep], new Map());

    // 一轮就收敛，且投出去的是最新那一份。
    expect(persistPendingBlockedRemovals).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ ...sweep, userIds: [42, 43] }]);
    expect(requestBlocklistResweep).not.toHaveBeenCalled();
  });

  test("对账轮次用尽只摘掉处置、不补 join：批次还在 outbox 里，人仍待清出去", async () => {
    // 这一档与「被取消」不同：任务没丢，只是这次不投。补一个验证窗口等于给一个
    // 仍在黑名单上的人开门。
    let round: number = 0;
    authoritative = new Map();
    const shifting = {
      get(removalId: number): RemoveBlockedMembersParams | undefined {
        return removalId === 7
          ? { chatId: -1001, userIds: [42, ++round], probeMembership: false, removalId: 7 }
          : undefined;
      },
    } as Map<number, RemoveBlockedMembersParams>;
    authoritative = shifting;

    const result = await prepareDurableAntiRaidMessages([removal], new Map([[7, replacedJoin]]));

    expect(result).toEqual([]);
    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
    expect(errorLogs.some((line: string): boolean => line.includes("durability rounds"))).toBeTrue();
  });
});
