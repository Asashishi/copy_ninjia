import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../../packages/consts/antiRaid";
import type { AntiRaidWorkerEvent, VerificationSnapshot } from "../../../packages/types";

const actions: string[] = [];
const workerEvents: AntiRaidWorkerEvent[] = [];
let kickSucceeds: boolean = true;
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(event: AntiRaidWorkerEvent): void { workerEvents.push(event); } },
});

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/config", () => ({ PRIVILEGED_USERS_ID: [] }));
mock.module("../../../packages/infra/telegram", () => ({
  joinVerificationApi: {},
  sendMessage: async (): Promise<number> => {
    actions.push("notice");
    return 900;
  },
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> => {
    actions.push(`delete:${messageId}`);
    return messageId !== 2;
  },
  deleteMessageAfter(): void { actions.push("schedule-notice-delete"); },
  kickChatMember: async (): Promise<boolean> => {
    actions.push("kick");
    return kickSucceeds;
  },
  answerCallbackQuery: async (): Promise<void> => {},
}));

const runtime = await import("../../../packages/workers/antiRaid/verificationRuntime");
const {
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} = await import("../../../packages/cache/antiRaid/verification");

beforeEach(() => {
  for (const entry of verificationEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  verificationEntries.clear();
  verificationRevisions.clear();
  verificationGeneration.current = 0;
  actions.length = 0;
  workerEvents.length = 0;
  kickSucceeds = true;
});

describe("Anti-Raid pending-member flood handling", () => {
  test("第 46 条先踢后清理，单条删除失败不中断，迟到消息不重复处置", async () => {
    const record: VerificationSnapshot = {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 1,
      phase: "pending",
      label: "刷屏者",
      isBot: false,
      messageIds: [900],
      replyReminderMessageId: 900,
      trackedMessageTimes: [],
      replyReminderRequested: true,
      reminderSuperseded: true,
      joinedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [record] });

    const now: number = Date.now();
    for (let messageId = 1; messageId <= ANTI_RAID_PER_MINUTE_LIMIT; messageId++) {
      runtime.dispatchVerification(-1001, 42, {
        type: "trackedMessage",
        messageId,
        inCommentThread: false,
        now,
      });
    }
    expect(verificationEntries.has("-1001:42")).toBeTrue();
    expect(actions).toEqual([]);

    runtime.dispatchVerification(-1001, 42, {
      type: "trackedMessage",
      messageId: ANTI_RAID_PER_MINUTE_LIMIT + 1,
      inCommentThread: false,
      now,
    });
    expect(verificationEntries.get("-1001:42")?.state.kind).toBe("expelling");
    expect(actions).toEqual([]);
    const terminal = workerEvents.findLast((event) => event.type === "verificationUpsert");
    expect(terminal).toMatchObject({ type: "verificationUpsert", record: { phase: "expelling", expelReason: "flood" } });
    if (terminal?.type !== "verificationUpsert") throw new Error("missing terminal upsert");
    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: terminal.record.generation,
      revision: terminal.record.revision,
    });
    expect(actions[0]).toBe("kick");

    await Bun.sleep(10);
    expect(actions).toEqual([
      "kick",
      "delete:900",
      ...Array.from({ length: ANTI_RAID_PER_MINUTE_LIMIT + 1 }, (_, index) => `delete:${index + 1}`),
      "notice",
      "schedule-notice-delete",
    ]);
    expect(verificationEntries.has("-1001:42")).toBeTrue();
    expect(verificationEntries.get("-1001:42")?.timer).toBeUndefined();
    const noticePersist = workerEvents.findLast((event) =>
      event.type === "verificationUpsert" && event.record.successNoticeSent === true
    );
    expect(noticePersist).toMatchObject({ type: "verificationUpsert", record: { successNoticeSent: true } });
    if (noticePersist?.type !== "verificationUpsert") throw new Error("missing success-notice upsert");
    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: noticePersist.record.generation,
      revision: noticePersist.record.revision,
    });
    expect(verificationEntries.has("-1001:42")).toBeFalse();

    runtime.dispatchVerification(-1001, 42, {
      type: "trackedMessage",
      messageId: 999,
      inCommentThread: false,
      now,
    });
    await Bun.sleep(0);
    expect(actions.filter((action) => action === "kick")).toHaveLength(1);
  });

  test("恢复已持久化的成功播报终态时直接收尾，不重复踢人、删消息或播报", async () => {
    const record: VerificationSnapshot = {
      chatId: -1003,
      userId: 44,
      generation: 2,
      revision: 3,
      phase: "expelling",
      expelReason: "flood",
      successNoticeSent: true,
      label: "已经处置的成员",
      isBot: false,
      messageIds: [101],
      trackedMessageTimes: [],
      replyReminderRequested: false,
      reminderSuperseded: true,
      joinedAt: Date.now(),
      expiresAt: Date.now(),
    };

    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 2,
      verifications: [record],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);

    expect(verificationEntries.has("-1003:44")).toBeFalse();
    expect(actions).toEqual([]);
    expect(workerEvents).toContainEqual(expect.objectContaining({
      type: "verificationDelete",
      chatId: -1003,
      userId: 44,
    }));
  });

  test("踢人失败时保留持久化终态并安排重试，成功后才发布删除", async () => {
    kickSucceeds = false;
    const record: VerificationSnapshot = {
      chatId: -1002,
      userId: 43,
      generation: 1,
      revision: 1,
      phase: "expelling",
      expelReason: "timeout",
      label: "暂时踢不动的成员",
      isBot: false,
      messageIds: [],
      trackedMessageTimes: [],
      replyReminderRequested: false,
      reminderSuperseded: true,
      joinedAt: Date.now(),
      expiresAt: Date.now(),
    };
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [record],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);

    expect(verificationEntries.get("-1002:43")?.state.kind).toBe("expelling");
    expect(verificationEntries.get("-1002:43")?.timer).toBeDefined();
    expect(workerEvents.some((event) => event.type === "verificationDelete")).toBeFalse();

    kickSucceeds = true;
    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1002:43",
      generation: 1,
      revision: 1,
    });
    await Bun.sleep(0);

    const successPersist = workerEvents.findLast((event) =>
      event.type === "verificationUpsert" &&
      event.record.chatId === -1002 &&
      event.record.userId === 43 &&
      event.record.successNoticeSent === true
    );
    if (successPersist?.type !== "verificationUpsert") throw new Error("missing success-notice upsert");
    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1002:43",
      generation: successPersist.record.generation,
      revision: successPersist.record.revision,
    });

    expect(verificationEntries.has("-1002:43")).toBeFalse();
    expect(workerEvents.some((event) => event.type === "verificationDelete")).toBeTrue();
  });
});
