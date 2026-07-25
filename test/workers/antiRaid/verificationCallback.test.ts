import { afterEach, describe, expect, mock, test } from "bun:test";
import type { VerificationSnapshot } from "../../../packages/types/antiRaid";

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/config", () => ({
  PRIVILEGED_USERS_ID: [900],
}));
mock.module("../../../packages/infra/telegram", () => ({
  joinVerificationApi: {},
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => true,
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(): void {} },
});

const runtime = await import(
  "../../../packages/workers/antiRaid/verificationRuntime"
);
const { verificationEntries } = await import(
  "../../../packages/cache/antiRaid/verification"
);

function pendingRecord(userId: number, isBot: boolean): VerificationSnapshot {
  return {
    chatId: -1001,
    userId,
    generation: 1,
    revision: 1,
    phase: "pending",
    label: isBot ? "待验证机器人" : "待验证成员",
    isBot,
    messageIds: [500],
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

afterEach(() => {
  runtime.stopVerificationRuntime();
});

describe("verification callback ownership", () => {
  test("普通用户不能替真人点击，本人点击才会通过", () => {
    adoptPending(42);

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "other-user",
      chatId: -1001,
      targetUserId: 42,
      from: { id: 43, first_name: "Other" },
    });
    expect(verificationEntries.get("-1001:42")?.state.kind).toBe("pending");

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "self",
      chatId: -1001,
      targetUserId: 42,
      from: { id: 42, first_name: "Self" },
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
    });
    expect(verificationEntries.get("-1001:45")?.state.kind).toBe("pending");

    runtime.handleVerificationCallback({
      type: "callback",
      callbackQueryId: "privileged-bot-vouch",
      chatId: -1001,
      targetUserId: 45,
      from: { id: 900, first_name: "Privileged" },
    });
    expect(verificationEntries.has("-1001:45")).toBeFalse();
  });
});
