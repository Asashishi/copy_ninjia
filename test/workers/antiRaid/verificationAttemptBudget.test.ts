import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AntiRaidWorkerEvent,
  VerificationSnapshot,
} from "../../../packages/types";

const workerEvents: AntiRaidWorkerEvent[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: {
    postMessage(event: AntiRaidWorkerEvent): void {
      workerEvents.push(event);
    },
  },
});

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: {},
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageWithOutcome: async (): Promise<"deleted"> => "deleted",
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => true,
  kickChatMemberWithOutcome: async (): Promise<"kicked"> => "kicked",
  probeChatMembership: async (): Promise<boolean> => true,
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const runtime = await import(
  "../../../packages/workers/antiRaid/verificationRuntime"
);
const {
  deferredVerificationRecords,
  verificationEntries,
} = await import(
  "../../../packages/cache/workers/antiRaid/verification"
);

function terminalRecord(generation: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation,
    revision: 3,
    phase: "expelling",
    label: "待处置成员",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: true,
    joinedAt: 1_000,
    expiresAt: 2_000,
    expelReason: "timeout",
  };
}

beforeEach(() => {
  runtime.stopVerificationRuntime();
  workerEvents.length = 0;
});

describe("Anti-Raid Worker verification attempt budget", () => {
  test("耗尽转移卸载运行态但不发 tombstone，并阻止同 key 再入群重建", () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [terminalRecord(1)],
    });

    runtime.dispatchVerification(-1001, 42, {
      type: "terminalAttemptBudgetExhausted",
    });
    expect(verificationEntries.has("-1001:42")).toBeFalse();
    expect(deferredVerificationRecords.get("-1001:42")).toEqual({
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 3,
    });
    expect(workerEvents).toEqual([{
      type: "verificationDeferred",
      record: {
        chatId: -1001,
        userId: 42,
        generation: 1,
        revision: 3,
      },
    }]);

    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 2,
      verifications: [],
      deferredVerifications: [{
        chatId: -1001,
        userId: 42,
        generation: 2,
        revision: 3,
      }],
    });
    runtime.handleJoin({
      type: "join",
      chatId: -1001,
      member: { id: 42, first_name: "Same member" },
      actorIsWhitelisted: false,
    });
    expect(verificationEntries.has("-1001:42")).toBeFalse();
    expect(workerEvents).toHaveLength(1);

    expect(runtime.deleteDeferredVerification(-1001, 42)).toBeTrue();
    expect(workerEvents[1]).toEqual({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 2,
      revision: 4,
    });
  });
});
