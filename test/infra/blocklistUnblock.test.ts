import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { BlockedMemberRemover } from "../../packages/types/blocklist";
import type {
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
} from "../../packages/types/diskIO";

/**
 * `/unblock` 的主线程侧：内存 Map 先删、再把删除之后的**整份** Map 投给落盘
 * Worker 整文件重写。黑名单文件是追加型的，没有「删掉一条」这种写法。
 */

const diskMessages: DiskBusinessMessage[] = [];
const respawnListeners: DiskIORespawnListener[] = [];
let postSucceeds: boolean = true;
/** 返回真正投出的条数（见 types/blocklist.ts 的 BlockedMemberRemover）：整批都投出去。 */
const remover = mock(async (...args: unknown[]): Promise<number> =>
  (args[0] as readonly unknown[]).length);
const loggedErrors: string[] = [];
const chatStates: Map<number, { isInitEnabled?: boolean; botIsAdmin?: boolean }> =
  new Map<number, { isInitEnabled?: boolean; botIsAdmin?: boolean }>();

mock.module("../../packages/infra/logger", () => ({
  logger: {
    log(): void {}, info(): void {}, warn(): void {},
    error(message: string): void { loggedErrors.push(message); },
  },
}));
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    if (postSucceeds) diskMessages.push(message);
    return postSucceeds;
  },
  onDiskIORespawn: (_owner: string, _priority: number, listener: DiskIORespawnListener): void => {
    respawnListeners.push(listener);
  },
  relayLogMessage: (): boolean => true,
  flushDiskIO: async (): Promise<string> => "flushed",
  flushDiskIODomain: async (): Promise<string> => "flushed",
  flushDiskIODomainOutcome: async (): Promise<{ result: string }> => ({ result: "flushed" }),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): ReadonlyMap<number, { isInitEnabled?: boolean; botIsAdmin?: boolean }> =>
    chatStates,
}));

const {
  blockUser,
  isUserBlocked,
  unblockUser,
} = await import("../../packages/infra/blocklist/membership");
const {
  getPendingBlockedRemovalParams,
  hydrateBlocklist,
  registerBlockedMemberRemover,
} = await import("../../packages/infra/blocklist/outbox");
const {
  sweepBlockedMembers,
} = await import("../../packages/infra/blocklist/sweep");
const {
  blockedUserIds,
  blocklistRemovalCounter,
  blocklistSweepState,
  configuredBlockedIds,
  pendingBlockedRemovals,
  sessionBlocklistRequiresRewrite,
  sessionBlockedAt,
} = await import("../../packages/cache/main/blocklist");

const recoveryTransport: DiskIORecoveryTransport = {
  post: (message: DiskBusinessMessage): boolean => {
    if (postSucceeds) diskMessages.push(message);
    return postSucceeds;
  },
  ensureLuckReceiptSecret: async (): Promise<never> => {
    throw new Error("Unexpected luck secret request.");
  },
};

/** 落盘端收到的最后一条 unblockUser 消息。 */
function lastRewrite(): { userId: number; blocked: readonly (readonly [number, unknown])[] } {
  const rewrites = diskMessages.filter((message) => message.type === "unblockUser");
  return rewrites.at(-1) as never;
}

beforeEach(() => {
  diskMessages.length = 0;
  chatStates.clear();
  // respawnListeners 不清：onDiskIORespawn 只在模块 import 时登记一次，
  // 清掉之后后面的用例就再也触发不到重放了。
  loggedErrors.length = 0;
  postSucceeds = true;
  blockedUserIds.clear();
  configuredBlockedIds.clear();
  sessionBlockedAt.clear();
  sessionBlocklistRequiresRewrite.current = false;
  blocklistSweepState.clear();
  pendingBlockedRemovals.clear();
  remover.mockClear();
  remover.mockImplementation(async (...args: unknown[]): Promise<number> =>
    (args[0] as readonly unknown[]).length);
  registerBlockedMemberRemover(remover as unknown as BlockedMemberRemover);
});

describe("解除拉黑", () => {
  test("读取时合并静态与动态两层，静态用户和频道都不能被运行时解除", () => {
    hydrateBlocklist(
      new Map([[8, {
        isBlocked: true,
        blockedAt: "2026/07/25 19:38:10",
      }]]),
      new Map(),
      [7, -4004]
    );

    expect(isUserBlocked(7)).toBeTrue();
    expect(isUserBlocked(-4004)).toBeTrue();
    expect(isUserBlocked(8)).toBeTrue();
    expect(unblockUser(7)).toBeFalse();
    expect(unblockUser(-4004)).toBeFalse();
    expect(diskMessages).toHaveLength(0);
    expect(blockedUserIds.has(8)).toBeTrue();
  });

  test("启动恢复只保留仍在黑名单且仍受管理的任务，并从最大历史 ID 继续编号", () => {
    chatStates.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    chatStates.set(-1002, { isInitEnabled: false, botIsAdmin: true });
    hydrateBlocklist(
      new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]),
      new Map([
        // 补扫：不带名单，恢复时没有可裁剪的东西，原样留下。
        [12, {
          params: { chatId: -1001, probeMembership: true, removalId: 12 },
          createdAt: 1_000,
          attempts: 1,
          lastFailure: "side-effect-incomplete",
        }],
        // 冻结名单的批次：8 已经不在名单里（停机期间被 /unblock），要裁掉。
        [14, {
          params: { chatId: -1001, probeMembership: false, userIds: [7, 8], removalId: 14 },
          createdAt: 1_500,
          attempts: 0,
          lastFailure: null,
        }],
        // 群已经 /init disable：整条丢弃。
        [15, {
          params: { chatId: -1002, probeMembership: false, userIds: [7], removalId: 15 },
          createdAt: 2_000,
          attempts: 0,
          lastFailure: null,
        }],
      ])
    );

    expect([...pendingBlockedRemovals]).toEqual([
      [12, {
        params: { chatId: -1001, probeMembership: true, removalId: 12 },
        createdAt: 1_000,
        attempts: 1,
        lastFailure: "side-effect-incomplete",
      }],
      [14, {
        params: { chatId: -1001, probeMembership: false, userIds: [7], removalId: 14 },
        createdAt: 1_500,
        attempts: 0,
        lastFailure: null,
      }],
    ]);
    expect(blocklistRemovalCounter.current).toBe(15);
    expect(diskMessages.at(-1)).toMatchObject({
      type: "blocklistRemovals",
      removals: [[12, expect.any(Object)], [14, expect.any(Object)]],
    });
  });

  test("先删内存 Map，再把删除之后的整份名单投出去重写", () => {
    hydrateBlocklist(new Map([
      [7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }],
      [8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }],
    ]));

    expect(unblockUser(7)).toBeTrue();

    // 判定立刻生效：投递还没落地，入群更新就已经不该再踢他了。
    expect(isUserBlocked(7)).toBeFalse();
    expect(isUserBlocked(8)).toBeTrue();
    // 追加型文件删不掉条目，只能整份重写；带的是剩下的人，不是被删的那个。
    expect(lastRewrite().userId).toBe(7);
    expect(lastRewrite().blocked).toEqual([[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]]);
  });

  test("重写带的是完整记录：不能把其他人的 blockedAt 抹平", () => {
    hydrateBlocklist(new Map([
      [7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }],
      [8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }],
      [9, { isBlocked: true, blockedAt: "2026/07/26 08:00:00" }],
    ]));

    unblockUser(8);

    expect(lastRewrite().blocked).toEqual([
      [7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }],
      [9, { isBlocked: true, blockedAt: "2026/07/26 08:00:00" }],
    ]);
  });

  test("本来就不在名单里时什么都不做", () => {
    expect(unblockUser(7)).toBeFalse();
    expect(diskMessages).toHaveLength(0);
  });

  test("解除最后一个人后重写成空名单", () => {
    hydrateBlocklist(new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]));

    unblockUser(7);

    expect(lastRewrite().blocked).toEqual([]);
  });

  test("投递失败要留下可排查的记录：文件里那条还在，重启会复活", () => {
    hydrateBlocklist(new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]));
    postSucceeds = false;

    expect(unblockUser(7)).toBeTrue();

    expect(isUserBlocked(7)).toBeFalse();
    expect(loggedErrors.some((message: string): boolean => message.includes("still on disk"))).toBeTrue();
  });

  test("把这个 id 从冻结名单的在途批次里摘掉，重放不会再封他一次", () => {
    chatStates.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    hydrateBlocklist(
      new Map([
        [7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }],
        [8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }],
      ]),
      new Map([[21, {
        params: { chatId: -1001, probeMembership: false, userIds: [7, 8], removalId: 21 },
        createdAt: 1_000,
        attempts: 0,
        lastFailure: null,
      }]])
    );

    unblockUser(7);

    // 批次里还剩 8，整批不能丢；但 7 必须摘掉，否则 Worker 重建后的重放会
    // 拿着这份旧批次把刚解除的人重新封掉。
    const remaining = [...pendingBlockedRemovals.values()][0]!.params;
    expect(remaining.probeMembership === false ? remaining.userIds : []).toEqual([8]);
  });

  test("冻结名单的批次里只剩他一个时整批销账", () => {
    chatStates.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    hydrateBlocklist(
      new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]),
      new Map([[21, {
        params: { chatId: -1001, probeMembership: false, userIds: [7], removalId: 21 },
        createdAt: 1_000,
        attempts: 0,
        lastFailure: null,
      }]])
    );

    unblockUser(7);

    expect(pendingBlockedRemovals.size).toBe(0);
  });

  test("补扫批次不必改写：它本来就不冻结名单，投递时现算已排除解除的人", async () => {
    hydrateBlocklist(new Map([
      [7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }],
      [8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }],
    ]));
    await sweepBlockedMembers(-1001, 1_000);
    const before = pendingBlockedRemovals.get(1);
    expect(before?.params.probeMembership).toBeTrue();

    unblockUser(7);

    // 条目原样留着（连对象都没换过），而它下一次投递/重放算出来的名单只剩 8。
    expect(pendingBlockedRemovals.get(1)).toBe(before!);
    expect(getPendingBlockedRemovalParams(1)?.userIds).toEqual([8]);
  });

  test("名单被清空时补扫批次整条销账，不在 outbox 里长住", async () => {
    // 现算恒为空集之后这条任务再也投不出去，留着只会白占 outbox 容量、还跨重启
    // 永生（恢复路径无条件保留补扫）。与冻结名单批次被裁空后销账是同一条规矩。
    hydrateBlocklist(new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]));
    await sweepBlockedMembers(-1001, 1_000);
    expect(pendingBlockedRemovals.size).toBe(1);

    unblockUser(7);

    expect(pendingBlockedRemovals.size).toBe(0);
  });

  test("补扫批次销账时放掉在途占位，这个群还扫得动", async () => {
    // removalId 非 null 是「这个群有一批在跑」的唯一凭据，sweepBlockedMembers
    // 开头据此早退。销账（而不是落定）之后不放掉它，回执永远不会来，这个群在
    // 本进程内再也扫不了——requestBlocklistResweep 也救不回来，它在有批次在途时
    // 只记 resweepRequested、把 removalId 原样留着。
    chatStates.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    hydrateBlocklist(new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]));
    await sweepBlockedMembers(-1001, 1_000);
    expect(blocklistSweepState.get(-1001)?.removalId).not.toBeNull();

    // 名单被清空 → 那条补扫再也投不出去 → 整条销账。
    unblockUser(7);

    expect(pendingBlockedRemovals.size).toBe(0);
    const progress = blocklistSweepState.get(-1001);
    expect(progress?.removalId).toBeNull();
    // 没扫成，欠着的那次仍然欠着。
    expect(progress?.sweptAt).toBeNull();

    // 再有人被拉黑时，这个群照常还能排上补扫（退避到点之后）。
    blockUser(9);
    await sweepBlockedMembers(-1001, 1_000 + 10 * 60_000);
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("启动恢复同样丢弃名单为空时的补扫条目", () => {
    chatStates.set(-1001, { isInitEnabled: true, botIsAdmin: true });

    hydrateBlocklist(
      new Map(),
      new Map([[21, {
        params: { chatId: -1001, probeMembership: true, removalId: 21 },
        createdAt: 1_000,
        attempts: 0,
        lastFailure: null,
      }]])
    );

    expect(pendingBlockedRemovals.size).toBe(0);
  });
});

describe("解除拉黑与落盘 Worker 重建", () => {
  test("本进程解除过：重建后整份重写，而不是只补投增量", async () => {
    hydrateBlocklist(new Map([
      [7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }],
      [8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }],
    ]));
    unblockUser(7);
    diskMessages.length = 0;

    for (const listener of respawnListeners) {
      expect(await listener(recoveryTransport)).toBeTrue();
    }
    postSucceeds = false;
    for (const listener of respawnListeners) {
      expect(await listener(recoveryTransport)).toBeFalse();
    }
    postSucceeds = true;

    // 新 Worker 从文件 hydrate，7 号那条还在里面；追加补不回「删除」，
    // 只有整份重写能让磁盘重新等于内存。
    expect(diskMessages.filter((message: DiskBusinessMessage): boolean => message.type === "unblockUser")).toHaveLength(1);
    expect(diskMessages.filter((message: DiskBusinessMessage): boolean => message.type === "blocklistRemovals")).toHaveLength(1);
    expect(lastRewrite().blocked).toEqual([[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]]);
  });

  test("没解除过就走原来的增量补投，不做 O(名单长度) 的重写", async () => {
    hydrateBlocklist(new Map([[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]]));
    blockUser(7);
    diskMessages.length = 0;

    for (const listener of respawnListeners) {
      expect(await listener(recoveryTransport)).toBeTrue();
    }

    expect(diskMessages.filter((message: DiskBusinessMessage): boolean => message.type === "blockUser")).toHaveLength(1);
    expect(diskMessages).toContainEqual(expect.objectContaining({ type: "blockUser", userId: 7 }));
  });

  test("先解除又重新拉黑：粘性重写最终权威快照，重放后他仍在名单上", async () => {
    hydrateBlocklist(new Map([[7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" }]]));
    unblockUser(7);
    blockUser(7);
    diskMessages.length = 0;

    for (const listener of respawnListeners) {
      expect(await listener(recoveryTransport)).toBeTrue();
    }

    // 解除标志保持粘性，重建只投一份包含最终拉黑记录的权威快照；不能在重新
    // 拉黑时清零，因为本进程还可能解除过其它身份。
    expect(isUserBlocked(7)).toBeTrue();
    expect(sessionBlocklistRequiresRewrite.current).toBeTrue();
    expect(diskMessages.filter((message: DiskBusinessMessage): boolean => message.type === "blockUser")).toHaveLength(0);
    expect(lastRewrite().blocked).toEqual([[7, expect.objectContaining({ isBlocked: true })]]);
  });

  test("高基数解除历史只保留常量空间的恢复标志", () => {
    for (let userId: number = 1; userId <= 20_000; userId++) {
      expect(blockUser(userId)).toBeTrue();
      expect(unblockUser(userId)).toBeTrue();
    }

    expect(blockedUserIds.size).toBe(0);
    expect(sessionBlockedAt.size).toBe(0);
    expect(sessionBlocklistRequiresRewrite).toEqual({ current: true });
  });
});
