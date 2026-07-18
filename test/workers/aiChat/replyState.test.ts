import { afterEach, describe, expect, test } from "bun:test";
import {
  pendingOverflowNotices,
  pendingReplyTriggers,
  replyGenerations,
} from "../../../src/cache/aiChatWorker";
import { LinkedQueue } from "../../../src/libs/linkedQueue";
import type { QueuedReplyTrigger } from "../../../src/types";
import {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
} from "../../../src/workers/aiChat/replyState";

afterEach(() => {
  pendingOverflowNotices.clear();
  pendingReplyTriggers.clear();
  replyGenerations.clear();
});

describe("AI 回复代际状态", () => {
  test("失效操作递增代数并清除尚未启动的工作", () => {
    const queue = new LinkedQueue<QueuedReplyTrigger>();
    queue.push({ replyToMessageId: 1, senderName: "Alice", text: "hello" });
    pendingReplyTriggers.set(-1001, queue);
    pendingOverflowNotices.add(-1001);
    const captured: number = currentReplyGeneration(-1001);

    invalidateChatReplies(-1001);

    expect(currentReplyGeneration(-1001)).toBe(captured + 1);
    expect(isReplyGenerationCurrent(-1001, captured)).toBe(false);
    expect(pendingReplyTriggers.has(-1001)).toBe(false);
    expect(pendingOverflowNotices.has(-1001)).toBe(false);
  });
});
