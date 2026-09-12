import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { waitUntil } from "../helpers/waitUntil";
import { LruCache } from "../../packages/libs/lruCache";
import type { ChatState, LockdownRecord } from "../../packages/types/chatState";

/**
 * 主线程紧急恢复遍历真实 LRU 的契约。
 *
 * `recoverAbandonedLockdowns()` 遍历的是生产的群状态 LRU，而恢复链在第一次
 * `await` 之前就会同步 `get` 当前这一条，把它挪到最新端——共享 harness 里那份普通
 * Map 没有链表，覆盖不到这段。这里只替身出站（Telegram 权限恢复）与落盘，缓存
 * 用真实 `LruCache`。
 */

const chatStates = new LruCache<number, ChatState>(25);
const restoreLockdownInvitePermission = mock(async (..._args: unknown[]): Promise<void> => {});
const saveChatStateInBackground = mock((_chatId: number, _context: string): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): LruCache<number, ChatState> => chatStates,
  clearChatStateField: (chatId: number, field: "lockdown"): boolean => {
    const state: ChatState | undefined = chatStates.get(chatId);
    if (state === undefined || state[field] === undefined) return false;
    delete state[field];
    return true;
  },
  saveChatStateInBackground,
}));
mock.module("../../packages/infra/telegram/client", () => ({
  telegramApi: { kind: "lockdown-iteration-test-api" },
}));
mock.module("../../packages/infra/telegram/lockdownPermissions", () => ({
  restoreLockdownInvitePermission,
}));

const {
  recoverAbandonedLockdowns,
  stopEmergencyLockdownRecoveries,
} = await import("../../packages/antiRaid/lockdownMirror");
const {
  emergencyLockdownRecoveries,
  emergencyLockdownRecoveryRuntime,
} = await import("../../packages/cache/main/antiRaid/lockdownMirror");

function lockdown(intentId: number): LockdownRecord {
  return {
    phase: "active",
    intentId,
    originalPermissions: { can_invite_users: true },
    announced: true,
    expiresAt: 10_000 + intentId,
  };
}

describe("主线程紧急恢复遍历真实群状态 LRU", () => {
  const chatIds: readonly number[] = [-7001, -7002, -7003];

  beforeEach(() => {
    chatStates.clear();
    emergencyLockdownRecoveries.clear();
    emergencyLockdownRecoveryRuntime.stopped = false;
    restoreLockdownInvitePermission.mockClear();
    saveChatStateInBackground.mockClear();
    loggerError.mockClear();
    for (const [index, chatId] of chatIds.entries()) {
      chatStates.set(chatId, { lockdown: lockdown(100 + index) } as ChatState);
    }
  });

  afterEach(() => {
    stopEmergencyLockdownRecoveries();
  });

  test("三群恢复挂起期间连续两次调用不重复发起，完成后各落盘一次并排空", async () => {
    const pending: (() => void)[] = [];
    restoreLockdownInvitePermission.mockImplementation(async (): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => { pending.push(resolve); });
    });

    recoverAbandonedLockdowns();
    // 第二次调用发生在三条恢复都还挂着的时候：每群已在册且指纹未变，必须直接返回。
    recoverAbandonedLockdowns();

    expect(restoreLockdownInvitePermission).toHaveBeenCalledTimes(chatIds.length);
    expect(emergencyLockdownRecoveries.size).toBe(chatIds.length);
    expect(chatStates.size).toBe(chatIds.length);

    for (const resolve of pending) resolve();
    await waitUntil((): boolean =>
      emergencyLockdownRecoveries.size === 0 &&
      saveChatStateInBackground.mock.calls.length >= chatIds.length);

    for (const chatId of chatIds) {
      expect(chatStates.get(chatId)?.lockdown).toBeUndefined();
    }
    expect(saveChatStateInBackground).toHaveBeenCalledTimes(chatIds.length);
    expect(emergencyLockdownRecoveries.size).toBe(0);
  });

  test("恢复期间被挪到最新端的条目不会让遍历漏群，也不会无限产出", () => {
    const visited: number[] = [];
    restoreLockdownInvitePermission.mockImplementation(async (input: unknown): Promise<void> => {
      visited.push((input as { chatId: number }).chatId);
      await new Promise<void>((): void => {});
    });
    // 有限步数哨兵：遍历真的不终止时，用例要失败而不是把测试挂住。这里只断言
    // 每群恰好发起一次恢复，不锁死链表被重排后的具体步数。
    const stepLimit: number = 64;
    let steps: number = 0;
    const originalIterator = chatStates[Symbol.iterator].bind(chatStates);
    chatStates[Symbol.iterator] = function* bounded(): IterableIterator<[number, ChatState]> {
      for (const entry of originalIterator()) {
        if (++steps > stepLimit) throw new Error("chat-state iteration did not terminate");
        yield entry;
      }
    };

    try {
      recoverAbandonedLockdowns();
    } finally {
      // 只摘掉刚才盖在实例上的那一层，让原型上的生成器重新生效。
      Reflect.deleteProperty(chatStates, Symbol.iterator);
    }

    expect(visited.slice().sort()).toEqual(chatIds.slice().sort());
    expect(steps).toBeLessThanOrEqual(stepLimit);
    expect(chatStates.size).toBe(chatIds.length);
  });
});
