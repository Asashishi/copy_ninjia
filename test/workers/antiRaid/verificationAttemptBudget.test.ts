import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type {
  AntiRaidWorkerEvent,
  VerificationAttemptPermitResult,
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
  logger: loggerStub(),
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
const sendTemporaryMessageFromMain = mock(
  async (): Promise<{ messageId: number; sentAt: number } | undefined> => ({ messageId: 900, sentAt: Date.now() })
);
mock.module("../../../packages/infra/telegram/workerClient", () => ({
  sendTemporaryMessageFromMain,
}));
/** 主线程批准的本进程尝试序号；用例直接给出上限那一次。 */
const requestVerificationAttemptPermit = mock(
  async (): Promise<VerificationAttemptPermitResult> => ({ status: "granted", attempt: 1 })
);
mock.module("../../../packages/workers/antiRaid/verificationAttemptPermit", () => ({
  requestVerificationAttemptPermit,
}));

const runtime = await import(
  "../../../packages/workers/antiRaid/verificationRuntime"
);
const { drainAntiRaidTasks } = await import(
  "../../../packages/workers/antiRaid/taskTracker"
);
const { applyChatKindChange, resetWorkerChatKind } = await import(
  "../../../packages/workers/antiRaid/chatKind"
);
const { VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS } = await import(
  "../../../packages/consts/antiRaid/verification"
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
  resetWorkerChatKind();
  sendTemporaryMessageFromMain.mockClear();
  requestVerificationAttemptPermit.mockReset();
  requestVerificationAttemptPermit.mockImplementation(
    async (): Promise<VerificationAttemptPermitResult> => ({ status: "granted", attempt: 1 })
  );
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

  test("上限那次许可踢出并发出战报后等落盘回执结算，不延后；成员重新入群照常验证", async () => {
    requestVerificationAttemptPermit.mockImplementation(
      async (): Promise<VerificationAttemptPermitResult> => ({
        status: "granted",
        attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
      })
    );
    applyChatKindChange(-1001, true);
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [terminalRecord(1)],
    });

    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 1,
      revision: 3,
    });
    await drainAntiRaidTasks();

    // 成功战报置位后发布了 revision 4；延后卸载会让它的落盘回执找不到条目。
    expect(sendTemporaryMessageFromMain).toHaveBeenCalledTimes(1);
    expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type))
      .toEqual(["verificationUpsert"]);
    expect(deferredVerificationRecords.has("-1001:42")).toBeFalse();
    expect(verificationEntries.has("-1001:42")).toBeTrue();

    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 1,
      revision: 4,
    });
    expect(verificationEntries.has("-1001:42")).toBeFalse();
    expect(workerEvents[1]).toEqual({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 5,
    });

    runtime.handleJoin({
      type: "join",
      chatId: -1001,
      member: { id: 42, first_name: "Same member" },
    });
    expect(verificationEntries.get("-1001:42")?.state.kind).toBe("pending");
    runtime.stopVerificationRuntime();
  });
});
