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
import {
  RESTORE_PERMANENT_FAILURE_LOG_LIMIT,
  RESTORE_PERMANENT_RETRY_MAX_MS,
  RESTORE_RETRY_MS,
} from "../../../packages/consts/antiRaid/lockdown";
import { loggerStub } from "../../helpers/loggerMock";
import type { LockdownEntry } from "../../../packages/types/antiRaid/internal";
import type { LockdownState } from "../../../packages/types/states/lockdown";

const CHAT_ID: number = -1001;
const BASE_MS: number = Date.parse("2026-03-01T00:00:00Z");
const REMAINING_MS: number = 60_000;
const ORIGINAL_PERMISSIONS: ChatPermissions = { can_send_messages: true, can_invite_users: true };

/** 每次 publishLockdownState 的 chatId，用于确认 persistState 副作用真的跑了。 */
const persisted: number[] = [];
/**
 * 恢复权限调用的结局队列：false 是普通失败，"denied" 是 Telegram 403，"aborted" 是 Worker 停机
 * 撤销的请求；出队为空时按成功处理。
 */
const restoreOutcomes: (false | "denied" | "aborted")[] = [];
const restoreCalls: number[] = [];
const loggerError = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});

/** 与跨线程回传的 Telegram 错误同形：带错误码与描述。 */
function deniedError(): Error {
  return Object.assign(new Error("Forbidden: bot was kicked from the supergroup chat"), {
    telegramErrorCode: 403,
    telegramDescription: "Forbidden: bot was kicked from the supergroup chat",
  });
}

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError, warn: loggerWarn }),
}));

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
    const outcome: false | "denied" | "aborted" | undefined = restoreOutcomes.shift();
    if (outcome === "denied") return Promise.reject(deniedError());
    if (outcome === "aborted") return Promise.reject(new DOMException("Worker request aborted", "AbortError"));
    return outcome === false
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
}));

const { lockdownApiChains, lockdownEntries } =
  await import("../../../packages/cache/workers/antiRaid/lockdown");
const {
  adoptLockdowns,
  handleLockdownPersisted,
  retryDeniedLockdownRestore,
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
  loggerError.mockClear();
  loggerWarn.mockClear();
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

  /** 走到 restoring 并确认落盘，让第一次解除权限调用开始。 */
  async function enterRestoring(): Promise<LockdownEntry> {
    adoptActiveLockdown();
    jest.advanceTimersByTime(REMAINING_MS);
    const entry: LockdownEntry = lockdownEntries.get(CHAT_ID)!;
    const restoring: LockdownState = entry.state;
    if (restoring.kind !== "restoring") throw new Error("restore timer did not enter restoring");
    handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId: CHAT_ID,
      phase: "restoring",
      intentId: restoring.intentId,
    });
    await drainLockdownApiChain();
    return entry;
  }

  test("连续权限被拒超过上限后降为 warn，重试间隔翻倍封顶，记录照旧保留", async (): Promise<void> => {
    jest.useFakeTimers({ now: BASE_MS });
    const extra: number = 12;
    for (let index: number = 0; index < RESTORE_PERMANENT_FAILURE_LOG_LIMIT + extra; index++) restoreOutcomes.push("denied");
    const entry: LockdownEntry = await enterRestoring();

    for (let attempt: number = 1; attempt < RESTORE_PERMANENT_FAILURE_LOG_LIMIT + extra; attempt++) {
      expect(restoreCalls).toHaveLength(attempt);
      const over: number = attempt - RESTORE_PERMANENT_FAILURE_LOG_LIMIT;
      const delayMs: number = over <= 0
        ? RESTORE_RETRY_MS
        : Math.min(RESTORE_RETRY_MS * 2 ** over, RESTORE_PERMANENT_RETRY_MAX_MS);
      jest.advanceTimersByTime(delayMs - 1);
      await drainLockdownApiChain();
      expect(restoreCalls).toHaveLength(attempt);
      jest.advanceTimersByTime(1);
      await drainLockdownApiChain();
    }

    expect(loggerError).toHaveBeenCalledTimes(RESTORE_PERMANENT_FAILURE_LOG_LIMIT);
    expect(loggerWarn).toHaveBeenCalledTimes(extra);
    expect(entry.restorePermanentFailures).toBe(RESTORE_PERMANENT_FAILURE_LOG_LIMIT + extra);
    expect(entry.state.kind).toBe("restoring");
    expect(lockdownEntries.get(CHAT_ID)).toBe(entry);
  });

  test("普通失败清零连续被拒计数，之后回到固定间隔并记错误", async (): Promise<void> => {
    jest.useFakeTimers({ now: BASE_MS });
    for (let index: number = 0; index <= RESTORE_PERMANENT_FAILURE_LOG_LIMIT; index++) restoreOutcomes.push("denied");
    restoreOutcomes.push(false);
    const entry: LockdownEntry = await enterRestoring();
    for (let index: number = 0; index < RESTORE_PERMANENT_FAILURE_LOG_LIMIT; index++) {
      jest.advanceTimersByTime(RESTORE_RETRY_MS);
      await drainLockdownApiChain();
    }
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(RESTORE_RETRY_MS * 2);
    await drainLockdownApiChain();

    expect(restoreCalls).toHaveLength(RESTORE_PERMANENT_FAILURE_LOG_LIMIT + 2);
    expect(entry.restorePermanentFailures).toBe(0);
    expect(loggerError).toHaveBeenCalledTimes(RESTORE_PERMANENT_FAILURE_LOG_LIMIT + 1);
    jest.advanceTimersByTime(RESTORE_RETRY_MS - 1);
    await drainLockdownApiChain();
    expect(restoreCalls).toHaveLength(RESTORE_PERMANENT_FAILURE_LOG_LIMIT + 2);
    jest.advanceTimersByTime(1);
    await drainLockdownApiChain();
    expect(lockdownEntries.has(CHAT_ID)).toBeFalse();
  });

  test("Worker 停机撤销的恢复请求不记错误，也不改连续被拒计数", async (): Promise<void> => {
    jest.useFakeTimers({ now: BASE_MS });
    restoreOutcomes.push("denied", "aborted");
    const entry: LockdownEntry = await enterRestoring();
    expect(entry.restorePermanentFailures).toBe(1);
    expect(loggerError).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(RESTORE_RETRY_MS);
    await drainLockdownApiChain();

    expect(restoreCalls).toHaveLength(2);
    expect(entry.restorePermanentFailures).toBe(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(entry.state.kind).toBe("restoring");
  });

  test("重新确证能限制成员时，被拒拉长的重试提前到现在", async (): Promise<void> => {
    jest.useFakeTimers({ now: BASE_MS });
    for (let index: number = 0; index <= RESTORE_PERMANENT_FAILURE_LOG_LIMIT; index++) restoreOutcomes.push("denied");
    await enterRestoring();
    for (let index: number = 0; index < RESTORE_PERMANENT_FAILURE_LOG_LIMIT; index++) {
      jest.advanceTimersByTime(RESTORE_RETRY_MS);
      await drainLockdownApiChain();
    }
    expect(restoreCalls).toHaveLength(RESTORE_PERMANENT_FAILURE_LOG_LIMIT + 1);

    retryDeniedLockdownRestore(CHAT_ID);
    jest.advanceTimersByTime(0);
    await drainLockdownApiChain();

    expect(restoreCalls).toHaveLength(RESTORE_PERMANENT_FAILURE_LOG_LIMIT + 2);
    expect(lockdownEntries.has(CHAT_ID)).toBeFalse();
  });

  test("没有被拒记录时提前重试是 no-op", async (): Promise<void> => {
    jest.useFakeTimers({ now: BASE_MS });
    restoreOutcomes.push(false);
    const entry: LockdownEntry = await enterRestoring();
    const timer: LockdownEntry["retryTimer"] = entry.retryTimer;

    retryDeniedLockdownRestore(CHAT_ID);

    expect(entry.retryTimer).toBe(timer);
    expect(restoreCalls).toHaveLength(1);
  });
});
