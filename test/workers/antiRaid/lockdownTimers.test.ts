/**
 * 私密模式解释器的两颗 timer 接线：恢复到期 timer 与共用的重试 timer。
 *
 * 状态机本身由 test/states/lockdown.test.ts 穷尽，这里守的是 lockdownRuntime.ts
 * 那两个回调体——`restoreTimerFired` / `restoreRetryFired` / `reapplyRetryFired`
 * 三个事件在全仓只由它们派发，接线错了（句柄没归零、投错事件、没排上）不会让
 * 任何门禁变红：群会一直锁着到进程重启，或者一次失败的恢复再也没有第二次尝试。
 */

import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import { RESTORE_RETRY_MS } from "../../../packages/consts/antiRaid/lockdown";
import type { LockdownEntry } from "../../../packages/types/antiRaid/internal";
import type { LockdownState } from "../../../packages/types/states/lockdown";

const CHAT_ID: number = -1001;
const BASE_MS: number = Date.parse("2026-03-01T00:00:00Z");
const REMAINING_MS: number = 60_000;
const ORIGINAL_PERMISSIONS: ChatPermissions = { can_send_messages: true, can_invite_users: true };

/** 每次 publishLockdownState 的 chatId，用于确认 persistState 副作用真的跑了。 */
const persisted: number[] = [];
/** 恢复权限调用的结局队列；出队为空时按成功处理。 */
const restoreOutcomes: boolean[] = [];
const restoreCalls: number[] = [];

mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  fetchAdminIds: (): Promise<ReadonlySet<number>> => Promise.resolve(new Set<number>()),
  freshAdminIds: (): ReadonlySet<number> | undefined => new Set<number>(),
}));
mock.module("../../../packages/workers/antiRaid/lockdownPersistence", () => ({
  publishLockdownState: (chatId: number): void => { persisted.push(chatId); },
}));
mock.module("../../../packages/infra/telegram/lockdownPermissions", () => ({
  restoreLockdownInvitePermission: (): Promise<void> => {
    restoreCalls.push(CHAT_ID);
    return restoreOutcomes.shift() === false
      ? Promise.reject(new Error("restore failed"))
      : Promise.resolve();
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  deleteMessage: (): Promise<boolean> => Promise.resolve(true),
  sendMessage: (): Promise<number | undefined> => Promise.resolve(undefined),
  telegramApi: {},
}));
mock.module("../../../packages/infra/telegram/workerClient", () => ({
  sendTemporaryMessageFromMain: (): Promise<undefined> => Promise.resolve(undefined),
}));
mock.module("../../../packages/workers/antiRaid/taskTracker", () => ({
  trackAntiRaidTask: ({ task }: { task: Promise<void> }): Promise<void> => task,
  antiRaidDispatchSignal: (): AbortSignal => new AbortController().signal,
}));

const { lockdownApiChains, lockdownEntries } =
  await import("../../../packages/cache/workers/antiRaid/lockdown");
const {
  adoptLockdowns,
  handleLockdownPersisted,
  stopLockdownRuntime,
} = await import("../../../packages/workers/antiRaid/lockdownRuntime");

/** 等这个群的串行 API 链跑完；恢复结果就是在链上的那个任务里回投状态机的。 */
async function drainLockdownApiChain(): Promise<void> {
  for (let round: number = 0; round < 8; round += 1) {
    const chain: Promise<void> | undefined = lockdownApiChains.get(CHAT_ID);
    if (chain === undefined) return;
    await chain;
  }
}

/** 接管一条仍在生效的 ACTIVE 私密模式，恢复倒计时还剩 REMAINING_MS。 */
function adoptActiveLockdown(): void {
  adoptLockdowns([{
    chatId: CHAT_ID,
    phase: "active",
    intentId: 1,
    originalPermissions: ORIGINAL_PERMISSIONS,
    announced: true,
    persisted: true,
    remainingMs: REMAINING_MS,
  }]);
}

beforeEach((): void => {
  persisted.length = 0;
  restoreCalls.length = 0;
  restoreOutcomes.length = 0;
  // reportUnlock 走 `self.postMessage`；基准线程没有 Worker 通道，替掉即可。
  spyOn(globalThis, "postMessage").mockImplementation((): void => undefined);
});

afterEach((): void => {
  stopLockdownRuntime();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("私密模式 timer 接线", (): void => {
  test("恢复 timer 到点：句柄归零、状态进入 restoring、意图先落盘", (): void => {
    jest.useFakeTimers({ now: BASE_MS });
    adoptActiveLockdown();

    const entry: LockdownEntry = lockdownEntries.get(CHAT_ID)!;
    expect(entry.state.kind).toBe("active");
    expect(entry.restoreTimer).toBeDefined();
    expect(entry.restoreAt).toBe(BASE_MS + REMAINING_MS);
    expect(persisted).toEqual([]);

    jest.advanceTimersByTime(REMAINING_MS);

    // 到点必须派发 restoreTimerFired：投成别的事件（或压根没派发）时状态会留在
    // active，群就一直锁到进程重启。
    expect(entry.state.kind).toBe("restoring");
    // 落盘优先：先记「要恢复」，回执之后才真的把权限还回去。
    expect(persisted).toEqual([CHAT_ID]);
    expect(restoreCalls).toEqual([]);
  });

  test("恢复失败排上重试 timer，到点重投 restoreRetryFired 再试一次", async (): Promise<void> => {
    jest.useFakeTimers({ now: BASE_MS });
    adoptActiveLockdown();
    jest.advanceTimersByTime(REMAINING_MS);

    const entry: LockdownEntry = lockdownEntries.get(CHAT_ID)!;
    const restoring: LockdownState = entry.state;
    if (restoring.kind !== "restoring") throw new Error("restore timer did not enter restoring");
    restoreOutcomes.push(false);
    // intentId 必须取状态里的那一个：restoreTimerFired 在**触发那一刻**才铸出它，
    // 落盘回执对不上号时状态机按迟到回执整条忽略。
    handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId: CHAT_ID,
      phase: "restoring",
      intentId: restoring.intentId,
    });
    await drainLockdownApiChain();
    expect(restoreCalls).toEqual([CHAT_ID]);
    expect(entry.retryTimer).toBeDefined();
    expect(entry.state.kind).toBe("restoring");

    jest.advanceTimersByTime(RESTORE_RETRY_MS);
    await drainLockdownApiChain();
    // 第二次尝试必须真的发生：重试 timer 没排上、或投错事件时这里恒为一次，
    // 那次失败的恢复就再也没有下文，群里留下一条谁都解不开的限制。
    // scheduleRestoreRetry 与 scheduleReapplyRetry 共用 scheduleLockdownRetry，
    // 事件字面量留在各自调用点，因此这一条同时守住两条副作用的接线。
    expect(restoreCalls).toEqual([CHAT_ID, CHAT_ID]);
    // 第二次成功：状态机收摊，条目连同两颗 timer 一起消失。
    expect(lockdownEntries.has(CHAT_ID)).toBeFalse();
  });
});
