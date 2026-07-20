import { describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerEvent, VerificationSnapshot, VerificationUpsertEvent } from "../../../src/types";

let kicks: number = 0;
const deletedMessageIds: number[] = [];
let blockNextDelete: boolean = false;
let releaseBlockedDelete: (() => void) | undefined;
const workerEvents: AntiRaidWorkerEvent[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage: (event: AntiRaidWorkerEvent): void => { workerEvents.push(event); } },
});

mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/config", () => ({ PRIVILEGED_USERS_ID: [] }));
mock.module("../../../src/infra/telegram", () => ({
  joinVerificationApi: {},
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> => {
    deletedMessageIds.push(messageId);
    if (blockNextDelete) {
      blockNextDelete = false;
      await new Promise<void>((resolve) => { releaseBlockedDelete = resolve; });
    }
    return messageId !== 10;
  },
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => { kicks++; return true; },
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const runtime = await import("../../../src/workers/antiRaid/verificationRuntime");
const { verificationEntries } = await import("../../../src/cache/antiRaid/verification");

function record(userId: number, expiresAt: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId,
    generation: 9,
    revision: 1,
    label: "待验证成员",
    isBot: false,
    messageIds: [10],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: Date.now() - 1_000,
    expiresAt,
  };
}

function settleLatestTerminal(userId: number): void {
  const event = workerEvents.findLast((candidate): candidate is VerificationUpsertEvent =>
    candidate.type === "verificationUpsert" && candidate.record.userId === userId && candidate.record.phase !== "pending"
  );
  if (!event) throw new Error(`missing terminal upsert for ${userId}`);
  runtime.handleVerificationPersisted({
    type: "verificationPersisted",
    key: `${event.record.chatId}:${event.record.userId}`,
    generation: event.record.generation,
    revision: event.record.revision,
  });
}

describe("Anti-Raid Worker verification recovery", () => {
  test("adopt uses remaining expiry, replaces old timers, and handles expired records immediately", async () => {
    const active: VerificationSnapshot = record(42, Date.now() + 100);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [active] });
    const firstEntry = verificationEntries.get("-1001:42");
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [active] });
    expect(verificationEntries.get("-1001:42")).toBe(firstEntry);

    runtime.adoptVerifications({ type: "adoptVerifications", generation: 2, verifications: [active] });
    await Bun.sleep(30);
    expect(kicks).toBe(0);
    await Bun.sleep(100);
    expect(kicks).toBe(0);
    settleLatestTerminal(42);
    await Bun.sleep(0);
    expect(kicks).toBe(1);

    const expired: VerificationSnapshot = record(43, Date.now() - 1);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
    expect(verificationEntries.get("-1001:43")?.state.kind).toBe("expelling");
    settleLatestTerminal(43);
    await Bun.sleep(0);
    expect(kicks).toBe(2);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
    await Bun.sleep(0);

    const verified: VerificationSnapshot = record(44, Date.now() + 10_000);
    const left: VerificationSnapshot = record(45, Date.now() + 10_000);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 4, verifications: [verified, left] });
    runtime.dispatchVerification(-1001, 44, {
      type: "callback",
      callbackQueryId: "callback-44",
      isSelf: true,
      fromIsPrivileged: false,
      fromLabel: "本人",
    });
    runtime.dispatchVerification(-1001, 45, { type: "left" });
    await Bun.sleep(0);

    expect(kicks).toBe(2);
    expect(verificationEntries.has("-1001:44") || verificationEntries.has("-1001:45")).toBeFalse();
    expect(workerEvents.filter((event) => event.type === "verificationDelete").map((event) => ({
      generation: event.generation,
      revision: event.revision,
      userId: event.userId,
    }))).toEqual([
      { generation: 2, revision: 3, userId: 42 },
      { generation: 3, revision: 3, userId: 43 },
      { generation: 4, revision: 2, userId: 44 },
      { generation: 4, revision: 2, userId: 45 },
    ]);
  });

  test("恢复部分完成的 expelling，并在同 userId 新一代入群后停止旧踢人", async () => {
    const baselineKicks: number = kicks;
    deletedMessageIds.length = 0;
    const terminal: VerificationSnapshot = {
      ...record(50, Date.now()),
      generation: 5,
      phase: "expelling",
      expelReason: "timeout",
      messageIds: [10, 11],
    };
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 5,
      verifications: [terminal],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);
    // 10 代表崩溃前已经删除过、恢复时 API 返回“目标不存在”；仍会继续 11 和踢人。
    expect(deletedMessageIds).toEqual([10, 11]);
    expect(kicks).toBe(baselineKicks + 1);

    const nextTerminal: VerificationSnapshot = {
      ...terminal,
      userId: 51,
      generation: 6,
      revision: 1,
      messageIds: [20],
    };
    blockNextDelete = true;
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 6,
      verifications: [nextTerminal],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);
    const beforeRejoinKicks: number = kicks;
    runtime.dispatchVerification(-1001, 51, {
      type: "join",
      memberId: 51,
      label: "重新入群",
      isBot: false,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: false,
      now: Date.now() + 1,
    });
    expect(verificationEntries.get("-1001:51")?.state.kind).toBe("pending");
    releaseBlockedDelete!();
    await Bun.sleep(0);
    expect(kicks).toBe(beforeRejoinKicks);
  });
});
