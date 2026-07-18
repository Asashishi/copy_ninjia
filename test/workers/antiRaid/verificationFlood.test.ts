import { describe, expect, mock, test } from "bun:test";
import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../../src/consts/antiRaid";
import type { VerificationSnapshot } from "../../../src/types";

const actions: string[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(): void {} },
});

mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/config", () => ({ PRIVILEGED_USERS_ID: [] }));
mock.module("../../../src/infra/telegram", () => ({
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
    return true;
  },
  answerCallbackQuery: async (): Promise<void> => {},
}));

const runtime = await import("../../../src/workers/antiRaid/verificationRuntime");
const { verificationEntries } = await import("../../../src/cache/antiRaidWorker");

describe("Anti-Raid pending-member flood handling", () => {
  test("第 46 条先踢后清理，单条删除失败不中断，迟到消息不重复处置", async () => {
    const record: VerificationSnapshot = {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 1,
      label: "刷屏者",
      isBot: false,
      messageIds: [],
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
        repliesToChannelPost: false,
        now,
      });
    }
    expect(verificationEntries.has("-1001:42")).toBeTrue();
    expect(actions).toEqual([]);

    runtime.dispatchVerification(-1001, 42, {
      type: "trackedMessage",
      messageId: ANTI_RAID_PER_MINUTE_LIMIT + 1,
      inCommentThread: false,
      repliesToChannelPost: false,
      now,
    });
    expect(verificationEntries.has("-1001:42")).toBeFalse();
    expect(actions[0]).toBe("kick");

    await Bun.sleep(10);
    expect(actions).toEqual([
      "kick",
      ...Array.from({ length: ANTI_RAID_PER_MINUTE_LIMIT + 1 }, (_, index) => `delete:${index + 1}`),
      "notice",
      "schedule-notice-delete",
    ]);

    runtime.dispatchVerification(-1001, 42, {
      type: "trackedMessage",
      messageId: 999,
      inCommentThread: false,
      repliesToChannelPost: false,
      now,
    });
    await Bun.sleep(0);
    expect(actions.filter((action) => action === "kick")).toHaveLength(1);
  });
});
