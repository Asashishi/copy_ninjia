import { describe, expect, mock, test } from "bun:test";
import type {
  AntiRaidWorkerEvent,
  AntiRaidWorkerMessage,
  VerificationDeleteDiskMessage,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationUpsertDiskMessage,
} from "../../../src/types";

const workerPosts: AntiRaidWorkerMessage[] = [];
const diskPosts: (VerificationUpsertDiskMessage | VerificationDeleteDiskMessage)[] = [];
let supervisorOptions: {
  onEvent: (event: AntiRaidWorkerEvent) => void;
  onRespawn: (post: (message: AntiRaidWorkerMessage) => void) => void;
} | undefined;
let diskRespawn: (() => void) | undefined;
let persistedAck: ((reply: VerificationPersistedReply) => void) | undefined;

mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/storage", () => ({
  getAllChatStates: (): Map<number, never> => new Map<number, never>(),
  getOrCreateChatState: (): Record<string, never> => ({}),
  saveStateInBackground(): void {},
}));
mock.module("../../../src/infra/telegram", () => ({ answerCallbackQuery: async (): Promise<boolean> => true }));
mock.module("../../../src/infra/botAdmin", () => ({
  isBotAdminIn: async (): Promise<boolean> => true,
  markBotAdminObserved(): void {},
}));
mock.module("../../../src/libs/supervisedWorker", () => ({
  superviseWorker: (options: typeof supervisorOptions) => {
    supervisorOptions = options;
    return {
      init(): void {},
      post: (message: AntiRaidWorkerMessage): void => { workerPosts.push(message); },
    };
  },
}));
mock.module("../../../src/infra/diskIO", () => ({
  postDiskIO: (message: VerificationUpsertDiskMessage | VerificationDeleteDiskMessage): void => { diskPosts.push(message); },
  onDiskIORespawn: (callback: () => void): void => { diskRespawn = callback; },
  onVerificationPersisted: (callback: (reply: VerificationPersistedReply) => void): void => { persistedAck = callback; },
}));

const antiRaid = await import("../../../src/antiRaid");
const { activeVerificationSnapshots, pendingVerificationDeletes } = await import("../../../src/cache/antiRaid");

function record(generation: number, revision: number): VerificationSnapshot {
  return {
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
  };
}

describe("Anti-Raid main-thread persistence mirror", () => {
  test("replays active and unconfirmed deletes while rejecting old generations", () => {
    antiRaid.hydratePendingVerifications(new Map([["-1001:42", record(9, 1)]]));
    antiRaid.initAntiRaid();
    supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(1, 2) });
    supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(0, 99) });
    supervisorOptions!.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 3 });
    diskRespawn!();
    expect(pendingVerificationDeletes.size).toBe(1);
    persistedAck!({ type: "verificationPersisted", key: "-1001:42", generation: 1, revision: 3, deleted: true });
    expect(pendingVerificationDeletes.size).toBe(0);

    supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(1, 4) });
    const respawnPosts: AntiRaidWorkerMessage[] = [];
    supervisorOptions!.onRespawn((message) => { respawnPosts.push(message); });
    supervisorOptions!.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 5 });

    expect(workerPosts[0]).toMatchObject({ type: "adoptVerifications", generation: 1, verifications: [{ revision: 1 }] });
    expect(diskPosts.map((message) => ({
      type: message.type,
      revision: message.type === "verificationUpsert" ? message.record.revision : message.revision,
      critical: message.type === "verificationUpsert" ? message.critical : undefined,
    }))).toEqual([
      { type: "verificationUpsert", revision: 2, critical: false },
      { type: "verificationDelete", revision: 3, critical: undefined },
      { type: "verificationDelete", revision: 3, critical: undefined },
      { type: "verificationUpsert", revision: 4, critical: true },
    ]);
    expect(respawnPosts).toEqual([expect.objectContaining({
      type: "adoptVerifications",
      generation: 2,
      verifications: [expect.objectContaining({ revision: 4 })],
    })]);
    expect(activeVerificationSnapshots.get("-1001:42")?.revision).toBe(4);
  });
});
