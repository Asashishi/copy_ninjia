import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import { waitUntil } from "../helpers/waitUntil";
import type { ChatState, LockdownRecord } from "../../packages/types/chatState";

/**
 * 主线程紧急恢复遍历群状态热读副本的契约。
 *
 * `recoverAbandonedLockdowns()` 遍历群状态热读副本，而恢复链在第一次 `await` 之前
 * 就会同步读取当前这一条；遍历必须每群恰好产出一次。这里只替身出站（Telegram
 * 权限恢复）与落盘，缓存与生产同为 `Map`。
 */

const chatStates = new Map<number, ChatState>();
const restoreLockdownInvitePermission = mock(async (..._args: unknown[]): Promise<void> => {});
const deleteMessageWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "deleted");
const saveChatStateInBackground = mock((_chatId: number, _context: string): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): ReadonlyMap<number, ChatState> => chatStates,
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
mock.module("../../packages/infra/telegram/actions", () => ({
  deleteMessageWithOutcome,
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
    restoreLockdownInvitePermission.mockReset();
    restoreLockdownInvitePermission.mockImplementation(async (): Promise<void> => {});
    deleteMessageWithOutcome.mockReset();
    deleteMessageWithOutcome.mockImplementation(async (): Promise<string> => "deleted");
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

  test("恢复任务自身拒绝时仍释放 inFlight，不留下未处理的拒绝", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    restoreLockdownInvitePermission.mockImplementation(async (): Promise<void> => {
      throw new Error("restore failed");
    });
    // 失败分支里记日志本身再抛，恢复任务整体拒绝。
    loggerError.mockImplementation((...args: unknown[]): void => {
      if (String(args[0]).startsWith("Emergency anti-raid permission restore failed")) throw new Error("logger failed");
    });
    try {
      recoverAbandonedLockdowns();
      const recoveries = chatIds.map((chatId: number) => emergencyLockdownRecoveries.get(chatId)!);
      await waitUntil((): boolean => recoveries.every((recovery): boolean => recovery.inFlight === null));
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
      expect(loggerError).toHaveBeenCalledTimes(chatIds.length + 1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      loggerError.mockImplementation((): void => {});
    }
  });

  test("恢复链同步读取当前条目时，遍历每群恰好一次，接管日志不重复列群", () => {
    const visited: number[] = [];
    restoreLockdownInvitePermission.mockImplementation(async (input: unknown): Promise<void> => {
      visited.push((input as { chatId: number }).chatId);
      await new Promise<void>((): void => {});
    });

    recoverAbandonedLockdowns();

    expect(visited).toEqual([...chatIds]);
    expect(chatStates.size).toBe(chatIds.length);
    const takeover: unknown[] | undefined = loggerError.mock.calls.find((call: unknown[]): boolean =>
      String(call[0]).startsWith("Anti-raid Worker gave up self-healing"));
    expect(takeover?.[0]).toBe(
      "Anti-raid Worker gave up self-healing; main-thread emergency permission recovery started for chats: " +
      chatIds.join(", ")
    );
  });
});

describe("主线程紧急恢复收尾时清理本轮封锁公告", () => {
  const announcedChatId: number = -7101;
  const silentChatId: number = -7102;

  function announcedLockdown(intentId: number, announcementMessageId: number): LockdownRecord {
    return { ...lockdown(intentId), announcementMessageId };
  }

  beforeEach(() => {
    chatStates.clear();
    emergencyLockdownRecoveries.clear();
    emergencyLockdownRecoveryRuntime.stopped = false;
    restoreLockdownInvitePermission.mockReset();
    restoreLockdownInvitePermission.mockImplementation(async (): Promise<void> => {});
    deleteMessageWithOutcome.mockReset();
    deleteMessageWithOutcome.mockImplementation(async (): Promise<string> => "deleted");
    saveChatStateInBackground.mockClear();
    loggerError.mockClear();
  });

  afterEach(() => {
    stopEmergencyLockdownRecoveries();
  });

  test("权限还原后先按公告 ID 定向删除，再清记录；没有公告 ID 的群不发删除", async () => {
    const recordPresentAtDelete: boolean[] = [];
    deleteMessageWithOutcome.mockImplementation(async (...args: unknown[]): Promise<string> => {
      recordPresentAtDelete.push(chatStates.get(args[0] as number)?.lockdown !== undefined);
      return "deleted";
    });
    chatStates.set(announcedChatId, { lockdown: announcedLockdown(201, 321) } as ChatState);
    chatStates.set(silentChatId, { lockdown: lockdown(202) } as ChatState);

    recoverAbandonedLockdowns();
    await waitUntil((): boolean =>
      emergencyLockdownRecoveries.size === 0 &&
      saveChatStateInBackground.mock.calls.length >= 2);

    // 公告 ID 只存在于这条记录里：清掉之后就再没有任何 owner 能删那条公告。
    expect(deleteMessageWithOutcome.mock.calls).toEqual([
      [announcedChatId, 321, { kind: "lockdown-iteration-test-api" }],
    ]);
    expect(recordPresentAtDelete).toEqual([true]);
    expect(chatStates.get(announcedChatId)?.lockdown).toBeUndefined();
    expect(chatStates.get(silentChatId)?.lockdown).toBeUndefined();
  });

  test("公告删除失败、悬挂或抛错都不阻塞恢复收尾", async () => {
    const hungChatId: number = -7103;
    deleteMessageWithOutcome.mockImplementation(async (...args: unknown[]): Promise<string> => {
      const chatId: number = args[0] as number;
      // 停机期间出站已关闭时，统一删除动作把拒绝结算成 failed 并自行记日志。
      if (chatId === announcedChatId) return "failed";
      if (chatId === hungChatId) return await new Promise<string>((): void => {});
      throw new Error("unexpected deletion boundary failure");
    });
    chatStates.set(announcedChatId, { lockdown: announcedLockdown(211, 331) } as ChatState);
    chatStates.set(silentChatId, { lockdown: announcedLockdown(212, 332) } as ChatState);
    chatStates.set(hungChatId, { lockdown: announcedLockdown(213, 333) } as ChatState);

    recoverAbandonedLockdowns();
    await waitUntil((): boolean =>
      emergencyLockdownRecoveries.size === 0 &&
      saveChatStateInBackground.mock.calls.length >= 3 &&
      loggerError.mock.calls.length >= 2);

    for (const chatId of [announcedChatId, silentChatId, hungChatId]) {
      expect(chatStates.get(chatId)?.lockdown).toBeUndefined();
    }
    expect(deleteMessageWithOutcome).toHaveBeenCalledTimes(3);
    expect(saveChatStateInBackground).toHaveBeenCalledTimes(3);
    expect(loggerError.mock.calls.some((call: unknown[]): boolean =>
      String(call[0]).includes(`announcement in chat ${silentChatId}`))).toBeTrue();
  });

  test("恢复期间意图已换代或恢复已停止时，不删新一轮或留给下一进程的公告", async () => {
    const pending: (() => void)[] = [];
    restoreLockdownInvitePermission.mockImplementation(async (): Promise<void> => {
      await new Promise<void>((resolve: () => void): void => { pending.push(resolve); });
    });
    chatStates.set(announcedChatId, { lockdown: announcedLockdown(221, 341) } as ChatState);

    recoverAbandonedLockdowns();
    chatStates.get(announcedChatId)!.lockdown = announcedLockdown(999, 342);
    for (const resolve of pending.splice(0)) resolve();
    await waitUntil((): boolean => emergencyLockdownRecoveries.size === 0);

    expect(chatStates.get(announcedChatId)?.lockdown?.announcementMessageId).toBe(342);

    chatStates.set(silentChatId, { lockdown: announcedLockdown(222, 343) } as ChatState);
    chatStates.delete(announcedChatId);
    recoverAbandonedLockdowns();
    await waitUntil((): boolean => pending.length === 1);
    stopEmergencyLockdownRecoveries();
    for (const resolve of pending.splice(0)) resolve();
    await Bun.sleep(0);

    expect(chatStates.get(silentChatId)?.lockdown?.announcementMessageId).toBe(343);
    expect(deleteMessageWithOutcome).not.toHaveBeenCalled();
    expect(saveChatStateInBackground).not.toHaveBeenCalled();
  });
});
