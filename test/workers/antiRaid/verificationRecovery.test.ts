import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const projectRoot: string = join(import.meta.dir, "..", "..", "..");

describe("Anti-Raid Worker verification recovery", () => {
  test("adopt uses remaining expiry, replaces old timers, and handles expired records immediately", () => {
    const script: string = `
      const { mock } = await import("bun:test");
      let kicks = 0;
      const workerEvents = [];
      globalThis.self = { postMessage: (event) => workerEvents.push(event) };
      mock.module("./src/infra/logger", () => ({
        logger: { log() {}, info() {}, warn() {}, error() {} },
      }));
      mock.module("./src/infra/config", () => ({ PRIVILEGED_USERS_ID: [] }));
      mock.module("./src/infra/telegram", () => ({
        joinVerificationApi: {},
        sendMessage: async () => undefined,
        deleteMessage: async () => true,
        deleteMessageAfter() {},
        kickChatMember: async () => { kicks++; return true; },
        answerCallbackQuery: async () => true,
      }));

      const runtime = await import("./src/workers/antiRaid/verificationRuntime.ts");
      const cache = await import("./src/cache/antiRaidWorker.ts");
      const record = (userId, expiresAt) => ({
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
      });

      const expiresAt = Date.now() + 100;
      const active = record(42, expiresAt);
      runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [active] });
      const firstEntry = cache.verificationEntries.get("-1001:42");
      runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [active] });
      const duplicateWasIdempotent = cache.verificationEntries.get("-1001:42") === firstEntry;

      runtime.adoptVerifications({ type: "adoptVerifications", generation: 2, verifications: [active] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const kicksBeforeExpiry = kicks;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const kicksAfterExpiry = kicks;

      const expired = record(43, Date.now() - 1);
      runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
      const expiredRemovedSynchronously = !cache.verificationEntries.has("-1001:43");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const kicksAfterImmediateExpiry = kicks;
      runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const verified = record(44, Date.now() + 10_000);
      const left = record(45, Date.now() + 10_000);
      runtime.adoptVerifications({ type: "adoptVerifications", generation: 4, verifications: [verified, left] });
      runtime.dispatchVerification(-1001, 44, {
        type: "callback",
        callbackQueryId: "callback-44",
        isSelf: true,
        fromIsPrivileged: false,
        fromLabel: "本人",
      });
      runtime.dispatchVerification(-1001, 45, { type: "left" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      process.stdout.write(JSON.stringify({
        duplicateWasIdempotent,
        kicksBeforeExpiry,
        kicksAfterExpiry,
        expiredRemovedSynchronously,
        kicksAfterImmediateExpiry,
        finalKicks: kicks,
        terminalRecordsRemoved: !cache.verificationEntries.has("-1001:44") && !cache.verificationEntries.has("-1001:45"),
        deletes: workerEvents.filter((event) => event.type === "verificationDelete").map((event) => ({
          generation: event.generation,
          revision: event.revision,
          userId: event.userId,
        })),
      }));
    `;
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      duplicateWasIdempotent: true,
      kicksBeforeExpiry: 0,
      kicksAfterExpiry: 1,
      expiredRemovedSynchronously: true,
      kicksAfterImmediateExpiry: 2,
      finalKicks: 2,
      terminalRecordsRemoved: true,
      deletes: [
        { generation: 2, revision: 2, userId: 42 },
        { generation: 3, revision: 2, userId: 43 },
        { generation: 4, revision: 2, userId: 44 },
        { generation: 4, revision: 2, userId: 45 },
      ],
    });
  });
});
