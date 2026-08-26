import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { VerificationSnapshot } from "../../../packages/types/antiRaid";

const loggerErrorMock = mock((_message: unknown, _error?: unknown): void => {});
const answerCallbackQueryMock = mock(async (): Promise<boolean> => true);

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
const {
  drainAntiRaidTasks,
  resetAntiRaidTaskTracker,
} = await import("../../../packages/workers/antiRaid/taskTracker");

function pendingRecord(userId: number, isBot: boolean): VerificationSnapshot {
  return {
    chatId: -1001,
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

beforeEach((): void => {
  loggerErrorMock.mockClear();
  answerCallbackQueryMock.mockClear();
  answerCallbackQueryMock.mockImplementation(
    async (): Promise<boolean> => true
  );
  resetAntiRaidTaskTracker();
});

afterEach((): void => {
  runtime.stopVerificationRuntime();
  resetAntiRaidTaskTracker();
});

describe("verification callback ownership", () => {
  test("缺少 chatId 的回调只确认 Telegram query，不进入验证状态机", async (): Promise<void> => {
    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "detached-callback",
      targetUserId: 42,
      from: { id: 42, first_name: "Self" },
      fromIsWhitelisted: false,
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
      from: { id: 43, first_name: "Self" },
      fromIsWhitelisted: false,
    });

    await drainAntiRaidTasks();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Error answering join verification callback:",
      failure
    );
  });

  test("普通用户不能替真人点击，本人点击才会通过", () => {
    adoptPending(42);

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "other-user",
      chatId: -1001,
      targetUserId: 42,
      from: { id: 43, first_name: "Other" },
      fromIsWhitelisted: false,
    });
    expect(verificationEntries.get("-1001:42")?.state.kind).toBe("pending");

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "self",
      chatId: -1001,
      targetUserId: 42,
      from: { id: 42, first_name: "Self" },
      fromIsWhitelisted: false,
    });
    expect(verificationEntries.has("-1001:42")).toBeFalse();
  });

  test("白名单用户也不能替真人点击", () => {
    adoptPending(44);

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "privileged-human-vouch",
      chatId: -1001,
      targetUserId: 44,
      from: { id: 900, first_name: "Privileged" },
      fromIsWhitelisted: true,
    });

    expect(verificationEntries.get("-1001:44")?.state.kind).toBe("pending");
  });

  test("只有白名单用户可以替机器人点击", () => {
    adoptPending(45, true);

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "ordinary-bot-vouch",
      chatId: -1001,
      targetUserId: 45,
      from: { id: 46, first_name: "Ordinary" },
      fromIsWhitelisted: false,
    });
    expect(verificationEntries.get("-1001:45")?.state.kind).toBe("pending");

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "privileged-bot-vouch",
      chatId: -1001,
      targetUserId: 45,
      from: { id: 900, first_name: "Privileged" },
      fromIsWhitelisted: true,
    });
    expect(verificationEntries.has("-1001:45")).toBeFalse();
  });
});
