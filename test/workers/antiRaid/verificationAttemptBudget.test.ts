import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AntiRaidWorkerEvent } from "../../../packages/types/antiRaid/events";
import type { VerificationAttemptPermitResult, VerificationPersistedMessage } from "../../../packages/types/antiRaid/protocol";
import type { VerificationSnapshot, VerificationSnapshotBase } from "../../../packages/types/antiRaid/verification";
import type { VerificationEntry } from "../../../packages/types/antiRaid/internal";

const getChatAdministrators: Mock<() => Promise<{ user: { id: number }; is_anonymous: boolean }[]>> = mock(async (): Promise<{ user: { id: number }; is_anonymous: boolean }[]> => []);
const kickChatMemberWithOutcome: Mock<() => Promise<"kicked">> = mock(async (): Promise<"kicked"> => "kicked");

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
  telegramApi: { getChatAdministrators },
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageWithOutcome: async (): Promise<"deleted"> => "deleted",
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => true,
  kickChatMemberWithOutcome,
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
const { handleJoinEvent } = await import("../../../packages/workers/antiRaid/verificationEvents");
const { drainAntiRaidTasks, quiesceAntiRaidDispatch, resetAntiRaidTaskTracker } = await import(
  "../../../packages/workers/antiRaid/taskTracker"
);
const { applyChatKindChange, resetWorkerChatKind } = await import(
  "../../../packages/workers/antiRaid/chatKind"
);
const { resetAdminCache } = await import("../../../packages/cache/workers/antiRaid/admins");
const { scheduleTerminalRetry } = await import("../../../packages/workers/antiRaid/verificationEffects/retry");
const { VERIFICATION_REVISION_CAPACITY, VERIFICATION_REVISION_RETENTION_MS, VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS } = await import(
  "../../../packages/consts/antiRaid/verification"
);
const {
  deferredVerificationRecords,
  verificationEntries,
  verificationRevisions,
} = await import(
  "../../../packages/cache/workers/antiRaid/verification"
);

type TerminalPhase = "kickPending" | "checkingInviter" | "expelling";

function terminalRecord(generation: number, phase: TerminalPhase = "expelling"): VerificationSnapshot {
  const base: VerificationSnapshotBase = {
    chatId: -1001,
    userId: 42,
    generation,
    revision: 3,
    label: "待处置成员",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: true,
    joinedAt: 1_000,
    expiresAt: 2_000,
  };
  switch (phase) {
    case "kickPending": return { ...base, phase, requestedAt: base.joinedAt };
    case "checkingInviter": return { ...base, phase, terminalInviterId: 77 };
    case "expelling": return { ...base, phase, expelReason: "timeout" };
  }
}

const TERMINAL_PHASES: readonly TerminalPhase[] = ["kickPending", "checkingInviter", "expelling"];
const ACK: VerificationPersistedMessage = {
  type: "verificationPersisted", key: "-1001:42", generation: 1, revision: 3,
};

/** 捕获终态 retry 回调；用例逐次触发 timer，不等待生产退避间隔。 */
function captureRetryTimers(callbacks: (() => void)[]): () => void {
  const timerSpy: Mock<typeof setTimeout> = spyOn(globalThis, "setTimeout").mockImplementation(
    ((callback: () => void): ReturnType<typeof setTimeout> => {
      callbacks.push(callback);
      return { unref(): void {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout
  );
  return (): void => { timerSpy.mockRestore(); };
}

beforeEach((): void => {
  runtime.stopVerificationRuntime();
  resetWorkerChatKind();
  resetAdminCache();
  getChatAdministrators.mockReset();
  getChatAdministrators.mockResolvedValue([]);
  kickChatMemberWithOutcome.mockClear();
  sendTemporaryMessageFromMain.mockClear();
  requestVerificationAttemptPermit.mockReset();
  requestVerificationAttemptPermit.mockImplementation(
    async (): Promise<VerificationAttemptPermitResult> => ({ status: "granted", attempt: 1 })
  );
  workerEvents.length = 0;
});
afterEach((): void => {
  runtime.stopVerificationRuntime();
  resetAntiRaidTaskTracker();
});

describe("Anti-Raid Worker verification attempt budget", (): void => {
  for (const phase of TERMINAL_PHASES) {
    for (const failure of ["reject", "stale"] as const) {
      test(`${phase} 许可 ${failure} 时保留磁盘快照并延后，不遗留关闭的执行门`, async (): Promise<void> => {
        if (failure === "reject") {
          requestVerificationAttemptPermit.mockRejectedValueOnce(new Error("duplex failed"));
        } else {
          requestVerificationAttemptPermit.mockResolvedValueOnce({ status: "stale", attempt: 0 });
        }
        runtime.adoptVerifications({
          type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, phase)],
        });
        runtime.handleVerificationPersisted(ACK);
        await drainAntiRaidTasks();

        expect(verificationEntries.has(ACK.key)).toBeFalse();
        expect(deferredVerificationRecords.get(ACK.key)).toMatchObject({ generation: 1, revision: 3 });
        expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type)).toEqual(["verificationDeferred"]);
        expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
        expect(getChatAdministrators).not.toHaveBeenCalled();
        runtime.handleVerificationPersisted(ACK);
        await drainAntiRaidTasks();
        expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(1);

        runtime.stopVerificationRuntime();
        applyChatKindChange(-1001, true);
        runtime.adoptVerifications({
          type: "adoptVerifications", generation: 2,
          verifications: [terminalRecord(2, phase)], resumePersistedTerminals: true,
        });
        await drainAntiRaidTasks();
        expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(2);
        expect(deferredVerificationRecords.has(ACK.key)).toBeFalse();
        expect(workerEvents.some((event: AntiRaidWorkerEvent): boolean => event.type === "verificationUpsert" || event.type === "verificationDelete")).toBeTrue();
      });
    }
    test(`${phase} 许可在途取消或换代后不得延后新 token`, async (): Promise<void> => {
      requestVerificationAttemptPermit.mockImplementationOnce(async (): Promise<VerificationAttemptPermitResult> => {
        runtime.adoptVerifications({
          type: "adoptVerifications", generation: 2, verifications: [terminalRecord(2, phase)],
        });
        throw new DOMException("cancelled", "AbortError");
      });
      runtime.adoptVerifications({
        type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, phase)],
      });
      runtime.handleVerificationPersisted(ACK);
      await drainAntiRaidTasks();
      expect(verificationEntries.get(ACK.key)?.state.kind).toBe(phase);
      expect(verificationEntries.get(ACK.key)?.timer).toBeUndefined();
      expect(deferredVerificationRecords.has(ACK.key)).toBeFalse();
      expect(workerEvents).toEqual([]);
      expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    });
    test(`${phase} 同代新 revision 或主动关闭使旧许可失效`, async (): Promise<void> => {
      requestVerificationAttemptPermit.mockImplementationOnce(async (): Promise<VerificationAttemptPermitResult> => {
        runtime.adoptVerifications({
          type: "adoptVerifications", generation: 1,
          verifications: [{ ...terminalRecord(1, phase), revision: 4 }],
        });
        return { status: "granted", attempt: 1 };
      });
      runtime.adoptVerifications({
        type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, phase)],
      });
      runtime.handleVerificationPersisted(ACK);
      await drainAntiRaidTasks();
      expect(verificationRevisions.get(ACK.key)?.revision).toBe(4);
      expect(workerEvents).toEqual([]);
      expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();

      requestVerificationAttemptPermit.mockImplementationOnce(async (): Promise<VerificationAttemptPermitResult> => {
        runtime.disableJoinGuardChat(-1001);
        throw new DOMException("cancelled", "AbortError");
      });
      runtime.handleVerificationPersisted({ ...ACK, revision: 4 });
      await drainAntiRaidTasks();
      expect(verificationEntries.has(ACK.key)).toBeFalse();
      expect(deferredVerificationRecords.has(ACK.key)).toBeFalse();
      expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type)).toEqual(["verificationDelete"]);
    });
  }

  test("业务生命周期取消时不新增延后责任或 retry timer", async (): Promise<void> => {
    requestVerificationAttemptPermit.mockImplementationOnce(async (): Promise<VerificationAttemptPermitResult> => {
      quiesceAntiRaidDispatch();
      throw new DOMException("cancelled", "AbortError");
    });
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1)],
    });
    runtime.handleVerificationPersisted(ACK);
    await drainAntiRaidTasks();
    expect(verificationEntries.get(ACK.key)?.timer).toBeUndefined();
    expect(deferredVerificationRecords.has(ACK.key)).toBeFalse();
    expect(workerEvents).toEqual([]);
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
  });

  test("未知身份在下一次 timer 复核确证管理员时解除验证，最后获准次数也不提前延后", async (): Promise<void> => {
    const callbacks: (() => void)[] = [];
    const restore: () => void = captureRetryTimers(callbacks);
    getChatAdministrators.mockRejectedValueOnce(new Error("admin query failed"));
    getChatAdministrators.mockResolvedValueOnce([{ user: { id: 77 }, is_anonymous: false }]);
    requestVerificationAttemptPermit.mockResolvedValueOnce({
      status: "granted", attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS - 1,
    });
    requestVerificationAttemptPermit.mockResolvedValueOnce({
      status: "granted", attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });
    try {
      runtime.adoptVerifications({
        type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, "checkingInviter")],
      });
      runtime.handleVerificationPersisted(ACK);
      await drainAntiRaidTasks();
      expect(callbacks).toHaveLength(1);
      callbacks[0]!();
      await drainAntiRaidTasks();
      expect(verificationEntries.get(ACK.key)?.state.kind).toBe("exempt");
      expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(2);
      expect(getChatAdministrators).toHaveBeenCalledTimes(2);
      expect(deferredVerificationRecords.has(ACK.key)).toBeFalse();
      expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type)).toEqual(["verificationDelete"]);
      expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
      callbacks[0]!();
      await drainAntiRaidTasks();
      expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stopVerificationRuntime();
      restore();
    }
  });

  test("未知身份退避后许可拒绝只延后原快照，不执行处置或写 tombstone", async (): Promise<void> => {
    const callbacks: (() => void)[] = [];
    const restore: () => void = captureRetryTimers(callbacks);
    getChatAdministrators.mockRejectedValueOnce(new Error("admin query failed"));
    requestVerificationAttemptPermit.mockResolvedValueOnce({ status: "granted", attempt: 1 });
    requestVerificationAttemptPermit.mockRejectedValueOnce(new Error("duplex failed"));
    try {
      runtime.adoptVerifications({
        type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, "checkingInviter")],
      });
      runtime.handleVerificationPersisted(ACK);
      await drainAntiRaidTasks();
      expect(verificationEntries.get(ACK.key)?.terminalRetries).toBe(1);
      callbacks[0]!();
      await drainAntiRaidTasks();
      expect(verificationEntries.has(ACK.key)).toBeFalse();
      expect(deferredVerificationRecords.get(ACK.key)).toMatchObject({ generation: 1, revision: 3 });
      expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type)).toEqual(["verificationDeferred"]);
      expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(2);
      expect(getChatAdministrators).toHaveBeenCalledTimes(1);
      expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    } finally {
      runtime.stopVerificationRuntime();
      restore();
    }
  });

  test("同 token 重排后旧 timer 不得启动复核，新 timer 清理句柄后正常执行", async (): Promise<void> => {
    const callbacks: (() => void)[] = [];
    const restore: () => void = captureRetryTimers(callbacks);
    try {
      runtime.adoptVerifications({
        type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, "checkingInviter")],
      });
      const entry: VerificationEntry = verificationEntries.get(ACK.key)!;
      for (let index: number = 0; index < 2; index++) {
        scheduleTerminalRetry({
          chatId: -1001, userId: 42, state: entry.state,
          event: { type: "terminalPersisted" }, dispatchVerification: runtime.dispatchVerification,
        });
      }
      const currentTimer: ReturnType<typeof setTimeout> | undefined = entry.timer;
      callbacks[0]!();
      await drainAntiRaidTasks();
      expect(requestVerificationAttemptPermit).not.toHaveBeenCalled();
      expect(entry.timer).toBe(currentTimer);
      callbacks[1]!();
      await drainAntiRaidTasks();
      expect(entry.timer).toBeUndefined();
      expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(1);
      expect(workerEvents[0]).toMatchObject({ type: "verificationUpsert", record: { phase: "expelling", revision: 4 } });
    } finally {
      runtime.stopVerificationRuntime();
      restore();
    }
  });

  test("成功播报的 durable ACK 始终可以收尾，即使已有 retry timer", (): void => {
    const record: VerificationSnapshot = terminalRecord(1, "expelling");
    if (record.phase !== "expelling") throw new Error("expected expelling fixture");
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: 1,
      verifications: [{ ...record, successNoticeSent: true }],
    });
    const entry: VerificationEntry = verificationEntries.get(ACK.key)!;
    scheduleTerminalRetry({
      chatId: -1001, userId: 42, state: entry.state,
      event: { type: "terminalPersisted" }, dispatchVerification: runtime.dispatchVerification,
    });
    runtime.handleVerificationPersisted(ACK);
    expect(verificationEntries.has(ACK.key)).toBeFalse();
    expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type)).toEqual(["verificationDelete"]);
    expect(requestVerificationAttemptPermit).not.toHaveBeenCalled();
  });

  test("身份复核一直未知到获准预算上限时只延后 checkingInviter，绝不踢人", async (): Promise<void> => {
    getChatAdministrators.mockRejectedValueOnce(new Error("admin query failed"));
    requestVerificationAttemptPermit.mockResolvedValueOnce({
      status: "granted", attempt: VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS,
    });
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, "checkingInviter")],
    });
    runtime.handleVerificationPersisted(ACK);
    await drainAntiRaidTasks();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(verificationEntries.has(ACK.key)).toBeFalse();
    expect(workerEvents.map((event: AntiRaidWorkerEvent): string => event.type)).toEqual(["verificationDeferred"]);
    expect(deferredVerificationRecords.get(ACK.key)).toMatchObject({ generation: 1, revision: 3 });
  });

  test("身份复核未知的退避期间重复 durable ACK 不提前再申请许可", async (): Promise<void> => {
    getChatAdministrators.mockRejectedValueOnce(new Error("admin query failed"));
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: 1, verifications: [terminalRecord(1, "checkingInviter")],
    });
    runtime.handleVerificationPersisted(ACK);
    await drainAntiRaidTasks();
    expect(verificationEntries.get(ACK.key)?.timer).toBeDefined();
    runtime.handleVerificationPersisted(ACK);
    await drainAntiRaidTasks();
    expect(requestVerificationAttemptPermit).toHaveBeenCalledTimes(1);
    expect(getChatAdministrators).toHaveBeenCalledTimes(1);
    expect(workerEvents).toEqual([]);
  });

  test("高周转终结键达到 revision 硬顶后拒收新 key，保留墓碑与已有 key 更新", () => {
    const base: VerificationSnapshot = {
      chatId: -1001, userId: 1, generation: 1, revision: 1, phase: "kickPending",
      label: "待处理成员", isBot: false, trackedMessageTimes: [], replyReminderRequested: false,
      reminderSuperseded: false, joinedAt: 1_000, expiresAt: 2_000, requestedAt: 1_000,
    };
    for (let userId: number = 1; userId <= VERIFICATION_REVISION_CAPACITY; userId++) {
      runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [{ ...base, userId }] });
      runtime.dispatchVerification(-1001, userId, { type: "left" });
    }
    expect(verificationEntries.size).toBe(0);
    expect(verificationRevisions.size).toBe(VERIFICATION_REVISION_CAPACITY);
    expect(verificationRevisions.get("-1001:1")).toMatchObject({ revision: 2 });
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [{ ...base, userId: VERIFICATION_REVISION_CAPACITY + 1 }] });
    expect(verificationRevisions.size).toBe(VERIFICATION_REVISION_CAPACITY);
    expect(verificationEntries.size).toBe(0);
    expect(workerEvents.at(-1)).toEqual({ type: "verificationRevisionCapacityExceeded", generation: 1 });
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [{ ...base, revision: 3 }] });
    expect(verificationEntries.has("-1001:1")).toBeTrue();
    runtime.dispatchVerification(-1001, 1, { type: "left" });
    expect(verificationRevisions.get("-1001:1")).toMatchObject({ revision: 4 });
    verificationRevisions.set("-1001:1", { revision: 4, retiredAt: Date.now() - VERIFICATION_REVISION_RETENTION_MS - 1 });
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [{ ...base, userId: VERIFICATION_REVISION_CAPACITY + 2 }] });
    expect(verificationEntries.has(`-1001:${VERIFICATION_REVISION_CAPACITY + 2}`)).toBeTrue();
    expect(verificationRevisions.size).toBe(VERIFICATION_REVISION_CAPACITY);
    expect(workerEvents.filter((event: AntiRaidWorkerEvent): boolean => event.type === "verificationRevisionCapacityExceeded")).toHaveLength(1);
  });
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
    handleJoinEvent({
      type: "join",
      chatId: -1001,
      member: { id: 42, first_name: "Same member" },
    }, runtime.dispatchVerification);
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

    handleJoinEvent({
      type: "join",
      chatId: -1001,
      member: { id: 42, first_name: "Same member" },
    }, runtime.dispatchVerification);
    expect(verificationEntries.get("-1001:42")?.state.kind).toBe("pending");
    runtime.stopVerificationRuntime();
  });
});
