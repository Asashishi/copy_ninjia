import { afterEach, describe, expect, test } from "bun:test";
import {
  activeReplyCounts,
  chatBuffers,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../../src/cache/aiChatWorker";
import { QUEUED_TRIGGER_SNIPPET_MAX_CHARS, REPLY_ROUND_MAX_CONCURRENT } from "../../../src/consts/aiChat";
import { LinkedQueue } from "../../../src/libs/linkedQueue";
import type { BufferedMessage, QueuedReplyTrigger } from "../../../src/types";
import { drainReplyQueue, pushReplyTrigger, triggerKindFor } from "../../../src/workers/aiChat/replyQueue";

afterEach(() => {
  activeReplyCounts.clear();
  chatBuffers.clear();
  pendingOverflowNotices.clear();
  pendingReplyTriggers.clear();
});

describe("AI 回复触发队列", () => {
  test("按随机、直接媒体和随机媒体分类", () => {
    const media = { kind: "photo" as const, senderName: "Alice", description: "一张图" };
    expect(triggerKindFor(true, undefined)).toBe("random");
    expect(triggerKindFor(true, { ...media, directTriggerReason: "mention" })).toBe("random");
    expect(triggerKindFor(false, undefined)).toBe("direct");
    expect(triggerKindFor(false, media)).toBe("mediaRandom");
    expect(triggerKindFor(false, { ...media, directTriggerReason: "reply" })).toBe("mediaDirect");
  });

  test("文本触发快照读取滚动缓存尾部并截断正文", () => {
    const messages = new LinkedQueue<BufferedMessage>();
    messages.push({ id: 1, firstName: "Older", lastName: "", text: "旧消息", at: "" });
    messages.push({ id: 2, firstName: "Alice", lastName: "Chen", text: "x".repeat(QUEUED_TRIGGER_SNIPPET_MAX_CHARS + 20), at: "" });
    chatBuffers.set(-1001, messages);

    pushReplyTrigger(-1001, 88, "机器人原话");

    expect(pendingReplyTriggers.get(-1001)?.shift()).toEqual({
      replyToMessageId: 88,
      repliedBotText: "机器人原话",
      senderName: "Alice Chen",
      text: "x".repeat(QUEUED_TRIGGER_SNIPPET_MAX_CHARS),
    });
  });

  test("媒体触发使用解析结果快照，不依赖缓存尾部", () => {
    pushReplyTrigger(-1001, 89, undefined, {
      kind: "animation",
      senderName: "Bob",
      description: "挥手",
      directTriggerReason: "mention",
    });

    expect(pendingReplyTriggers.get(-1001)?.shift()).toEqual({
      replyToMessageId: 89,
      repliedBotText: undefined,
      senderName: "Bob",
      text: "[GIF：挥手]",
    });
  });

  test("按 FIFO 补跑，并在回调占满并发位后保留剩余项", () => {
    const queue = new LinkedQueue<QueuedReplyTrigger>();
    queue.push({ replyToMessageId: 1, senderName: "A", text: "first" });
    queue.push({ replyToMessageId: 2, senderName: "B", text: "second" });
    pendingReplyTriggers.set(-1001, queue);
    activeReplyCounts.set(-1001, REPLY_ROUND_MAX_CONCURRENT - 1);
    const started: number[] = [];

    drainReplyQueue(-1001, (trigger: QueuedReplyTrigger) => {
      started.push(trigger.replyToMessageId);
      activeReplyCounts.set(-1001, REPLY_ROUND_MAX_CONCURRENT);
    });

    expect(started).toEqual([1]);
    expect(pendingReplyTriggers.get(-1001)?.peek()?.replyToMessageId).toBe(2);
  });
});
