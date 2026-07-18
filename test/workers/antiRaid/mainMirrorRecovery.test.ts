import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const projectRoot: string = join(import.meta.dir, "..", "..", "..");

describe("Anti-Raid main-thread persistence mirror", () => {
  test("replays active and unconfirmed deletes while rejecting old generations", () => {
    const script: string = `
      const { mock } = await import("bun:test");
      const workerPosts = [];
      const diskPosts = [];
      let supervisorOptions;
      let diskRespawn;
      let persistedAck;
      mock.module("./src/infra/logger", () => ({ logger: { log() {}, info() {}, warn() {}, error() {} } }));
      mock.module("./src/infra/storage", () => ({
        getAllChatStates: () => new Map(),
        getOrCreateChatState: () => ({}),
        saveStateInBackground() {},
      }));
      mock.module("./src/infra/telegram", () => ({ answerCallbackQuery: async () => true }));
      mock.module("./src/infra/botAdmin", () => ({ isBotAdminIn: async () => true, markBotAdminObserved() {} }));
      mock.module("./src/libs/supervisedWorker", () => ({
        superviseWorker: (options) => {
          supervisorOptions = options;
          return { init() {}, post: (message) => workerPosts.push(message) };
        },
      }));
      mock.module("./src/infra/diskIO", () => ({
        postDiskIO: (message) => diskPosts.push(message),
        onDiskIORespawn: (callback) => { diskRespawn = callback; },
        onVerificationPersisted: (callback) => { persistedAck = callback; },
      }));

      const antiRaid = await import("./src/antiRaid.ts");
      const cache = await import("./src/cache/antiRaid.ts");
      const record = (generation, revision) => ({
        chatId: -1001,
        userId: 42,
        generation,
        revision,
        label: "待验证成员",
        isBot: false,
        messageIds: [10],
        replyReminderRequested: false,
        reminderSuperseded: false,
        joinedAt: 1_000,
        expiresAt: 121_000,
      });

      antiRaid.hydratePendingVerifications(new Map([["-1001:42", record(9, 1)]]));
      antiRaid.initAntiRaid();
      supervisorOptions.onEvent({ type: "verificationUpsert", record: record(1, 2) });
      supervisorOptions.onEvent({ type: "verificationUpsert", record: record(0, 99) });
      supervisorOptions.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 3 });
      diskRespawn();
      const deletesBeforeAck = cache.pendingVerificationDeletes.size;
      persistedAck({ type: "verificationPersisted", key: "-1001:42", generation: 1, revision: 3, deleted: true });
      const deletesAfterAck = cache.pendingVerificationDeletes.size;

      supervisorOptions.onEvent({ type: "verificationUpsert", record: record(1, 4) });
      const respawnPosts = [];
      supervisorOptions.onRespawn((message) => respawnPosts.push(message));
      supervisorOptions.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 5 });

      process.stdout.write(JSON.stringify({
        initialAdopt: workerPosts[0],
        diskPosts,
        deletesBeforeAck,
        deletesAfterAck,
        respawnPosts,
        activeRevision: cache.activeVerificationSnapshots.get("-1001:42")?.revision,
      }));
    `;
    const result = Bun.spawnSync({ cmd: ["bun", "-e", script], cwd: projectRoot, stderr: "pipe", stdout: "pipe" });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(output.initialAdopt).toMatchObject({ type: "adoptVerifications", generation: 1, verifications: [{ revision: 1 }] });
    expect(output.diskPosts.map((message: { type: string; revision?: number; record?: { revision: number }; critical?: boolean }) => ({
      type: message.type,
      revision: message.revision ?? message.record?.revision,
      critical: message.critical,
    }))).toEqual([
      { type: "verificationUpsert", revision: 2, critical: false },
      { type: "verificationDelete", revision: 3, critical: undefined },
      { type: "verificationDelete", revision: 3, critical: undefined },
      { type: "verificationUpsert", revision: 4, critical: true },
    ]);
    expect(output.deletesBeforeAck).toBe(1);
    expect(output.deletesAfterAck).toBe(0);
    expect(output.respawnPosts).toEqual([expect.objectContaining({
      type: "adoptVerifications",
      generation: 2,
      verifications: [expect.objectContaining({ revision: 4 })],
    })]);
    expect(output.activeRevision).toBe(4);
  });
});
