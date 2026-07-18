import { describe, expect, mock, test } from "bun:test";
import type { VerificationDeleteEvent, VerificationSnapshot } from "../../../src/types";

let kicks: number = 0;
const workerEvents: VerificationDeleteEvent[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage: (event: VerificationDeleteEvent): void => { workerEvents.push(event); } },
});

mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/config", () => ({ PRIVILEGED_USERS_ID: [] }));
mock.module("../../../src/infra/telegram", () => ({
  joinVerificationApi: {},
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => { kicks++; return true; },
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const runtime = await import("../../../src/workers/antiRaid/verificationRuntime");
const { verificationEntries } = await import("../../../src/cache/antiRaidWorker");

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
    expect(kicks).toBe(1);

    const expired: VerificationSnapshot = record(43, Date.now() - 1);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
    expect(verificationEntries.has("-1001:43")).toBeFalse();
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
    expect(workerEvents.map((event) => ({
      generation: event.generation,
      revision: event.revision,
      userId: event.userId,
    }))).toEqual([
      { generation: 2, revision: 2, userId: 42 },
      { generation: 3, revision: 2, userId: 43 },
      { generation: 4, revision: 2, userId: 44 },
      { generation: 4, revision: 2, userId: 45 },
    ]);
  });
});
