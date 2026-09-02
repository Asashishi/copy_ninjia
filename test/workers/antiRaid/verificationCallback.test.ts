import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { VerificationSnapshot } from "../../../packages/types/antiRaid";

const loggerErrorMock = mock((_message: unknown, _error?: unknown): void => {});
const answerCallbackQueryMock = mock(async (_params: { callbackQueryId: string; text?: string }): Promise<boolean> => true);
const getChatAdministratorsMock = mock(
  async (_chatId: number): Promise<{ user: { id: number }; is_anonymous?: boolean }[]> => []
);

mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error: loggerErrorMock,
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: {
    getChat: async (): Promise<{ type: "supergroup" }> => ({ type: "supergroup" }),
    getChatAdministrators: getChatAdministratorsMock,
  },
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageWithOutcome: async (): Promise<string> => "deleted",
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => true,
  kickChatMemberWithOutcome: async (): Promise<"kicked"> => "kicked",
  probeChatMembership: async (): Promise<boolean> => true,
  answerCallbackQuery: answerCallbackQueryMock,
}));

Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(): void {} },
});

const runtime = await import(
  "../../../packages/workers/antiRaid/verificationRuntime"
);
const { verificationEntries } = await import(
  "../../../packages/cache/workers/antiRaid/verification"
);
const { cacheAdminIds, resetAdminCache } = await import(
  "../../../packages/cache/workers/antiRaid/admins"
);
const {
  drainAntiRaidTasks,
  resetAntiRaidTaskTracker,
} = await import("../../../packages/workers/antiRaid/taskTracker");

const CHAT_ID: number = -1001;
const ADMIN_ID: number = 900;

function pendingRecord(userId: number, isBot: boolean): VerificationSnapshot {
  return {
    chatId: CHAT_ID,
    userId,
    generation: 1,
    revision: 1,
    phase: "pending",
    label: isBot ? "待验证机器人" : "待验证成员",
    isBot,
    trackedMessageTimes: [],
    reminderMessageId: 500,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function adoptPending(userId: number, isBot: boolean = false): void {
  runtime.adoptVerifications({
    type: "adoptVerifications",
    generation: 1,
    verifications: [pendingRecord(userId, isBot)],
  });
}

interface ClickParams {
  callbackQueryId: string;
  targetUserId: number;
  action: "self" | "approve";
  fromId: number;
}

function click({ callbackQueryId, targetUserId, action, fromId }: ClickParams): void {
  runtime.handleVerificationCallback({
    type: "callback",
    callbackQueryId,
    chatId: CHAT_ID,
    targetUserId,
    action,
    from: { id: fromId, first_name: `User ${fromId}` },
  });
}

function answeredText(callbackQueryId: string): string | undefined {
  const call = answerCallbackQueryMock.mock.calls.find(
    ([params]) => params.callbackQueryId === callbackQueryId
  );
  return call?.[0].text;
}

beforeEach((): void => {
  loggerErrorMock.mockClear();
  answerCallbackQueryMock.mockClear();
  answerCallbackQueryMock.mockImplementation(
    async (): Promise<boolean> => true
  );
  getChatAdministratorsMock.mockClear();
  getChatAdministratorsMock.mockImplementation(async () => []);
  resetAdminCache();
  resetAntiRaidTaskTracker();
});

afterEach((): void => {
  runtime.stopVerificationRuntime();
  resetAdminCache();
  resetAntiRaidTaskTracker();
});

describe("verification callback ownership", () => {
  test("缺少 chatId 的回调只确认 Telegram query，不进入验证状态机", async (): Promise<void> => {
    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "detached-callback",
      targetUserId: 42,
      action: "self",
      from: { id: 42, first_name: "Self" },
    });

    await drainAntiRaidTasks();

    expect(answerCallbackQueryMock).toHaveBeenCalledTimes(1);
    expect(answerCallbackQueryMock).toHaveBeenCalledWith({
      callbackQueryId: "detached-callback",
      api: expect.any(Object),
    });
    expect(verificationEntries.size).toBe(0);
  });

  test("缺少 chatId 的回调确认失败时统一记录错误且任务正常结算", async (): Promise<void> => {
    const failure: Error = new Error("callback unavailable");
    answerCallbackQueryMock.mockRejectedValueOnce(failure);

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "detached-failure",
      targetUserId: 43,
      action: "self",
      from: { id: 43, first_name: "Self" },
    });

    await drainAntiRaidTasks();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Error answering join verification callback:",
      failure
    );
  });

  test("「我是良民」只认本人：别人点不动，本人点了才通过", () => {
    adoptPending(42);

    click({ callbackQueryId: "other-user", targetUserId: 42, action: "self", fromId: 43 });
    expect(verificationEntries.get(`${CHAT_ID}:42`)?.state.kind).toBe("pending");

    click({ callbackQueryId: "self", targetUserId: 42, action: "self", fromId: 42 });
    expect(verificationEntries.has(`${CHAT_ID}:42`)).toBeFalse();
  });

  test("管理员点「我是良民」同样驳回：那颗按钮不是代点入口", () => {
    adoptPending(44);
    cacheAdminIds(CHAT_ID, new Set([ADMIN_ID]));

    click({ callbackQueryId: "admin-self-button", targetUserId: 44, action: "self", fromId: ADMIN_ID });

    expect(verificationEntries.get(`${CHAT_ID}:44`)?.state.kind).toBe("pending");
    expect(getChatAdministratorsMock).not.toHaveBeenCalled();
  });

  test("管理员缓存热时「通过」同步结算：管理员放行，普通成员驳回", async (): Promise<void> => {
    adoptPending(45);
    cacheAdminIds(CHAT_ID, new Set([ADMIN_ID]));

    click({ callbackQueryId: "ordinary-approve", targetUserId: 45, action: "approve", fromId: 46 });
    await drainAntiRaidTasks();
    expect(verificationEntries.get(`${CHAT_ID}:45`)?.state.kind).toBe("pending");
    expect(answeredText("ordinary-approve")).toContain("管理员的特权");

    click({ callbackQueryId: "admin-approve", targetUserId: 45, action: "approve", fromId: ADMIN_ID });
    await drainAntiRaidTasks();
    expect(verificationEntries.has(`${CHAT_ID}:45`)).toBeFalse();
    expect(getChatAdministratorsMock).not.toHaveBeenCalled();
  });

  test("管理员可以替机器人点「通过」", async (): Promise<void> => {
    adoptPending(47, true);
    cacheAdminIds(CHAT_ID, new Set([ADMIN_ID]));

    click({ callbackQueryId: "bot-approve", targetUserId: 47, action: "approve", fromId: ADMIN_ID });
    await drainAntiRaidTasks();

    expect(verificationEntries.has(`${CHAT_ID}:47`)).toBeFalse();
  });

  test("管理员缓存冷时先拉一次全量再结算，匿名管理员不算", async (): Promise<void> => {
    adoptPending(48);
    getChatAdministratorsMock.mockResolvedValueOnce([
      { user: { id: ADMIN_ID }, is_anonymous: false },
      { user: { id: 901 }, is_anonymous: true },
    ]);

    click({ callbackQueryId: "cold-anonymous", targetUserId: 48, action: "approve", fromId: 901 });
    await drainAntiRaidTasks();
    expect(verificationEntries.get(`${CHAT_ID}:48`)?.state.kind).toBe("pending");
    expect(getChatAdministratorsMock).toHaveBeenCalledTimes(1);

    // 上一次拉取已把名单落进缓存，这次直接命中。
    click({ callbackQueryId: "cold-admin", targetUserId: 48, action: "approve", fromId: ADMIN_ID });
    await drainAntiRaidTasks();
    expect(verificationEntries.has(`${CHAT_ID}:48`)).toBeFalse();
    expect(getChatAdministratorsMock).toHaveBeenCalledTimes(1);
  });

  test("管理员名单拉不下来时只应答稍后再试，记录保持 pending", async (): Promise<void> => {
    adoptPending(49);
    getChatAdministratorsMock.mockRejectedValueOnce(new Error("admins unavailable"));

    click({ callbackQueryId: "fetch-failed", targetUserId: 49, action: "approve", fromId: ADMIN_ID });
    await drainAntiRaidTasks();

    expect(verificationEntries.get(`${CHAT_ID}:49`)?.state.kind).toBe("pending");
    expect(answeredText("fetch-failed")).toContain("稍后再点一次");
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  test("目标本人点「通过」不放行，也不为此拉管理员名单", async (): Promise<void> => {
    adoptPending(50);

    click({ callbackQueryId: "self-approve", targetUserId: 50, action: "approve", fromId: 50 });
    await drainAntiRaidTasks();

    expect(verificationEntries.get(`${CHAT_ID}:50`)?.state.kind).toBe("pending");
    expect(answeredText("self-approve")).toContain("我是良民");
    expect(getChatAdministratorsMock).not.toHaveBeenCalled();
  });

  test("目标已不在待验证表时「通过」直接应答失效，不拉管理员名单", async (): Promise<void> => {
    click({ callbackQueryId: "stale-approve", targetUserId: 51, action: "approve", fromId: ADMIN_ID });
    await drainAntiRaidTasks();

    expect(answeredText("stale-approve")).toContain("失效");
    expect(getChatAdministratorsMock).not.toHaveBeenCalled();
  });
});
