import { afterEach, describe, expect, test } from "bun:test";
import {
  activeReplyCounts,
  pendingReplyTriggers,
  resetAiChatReplyCache,
} from "../../../packages/cache/aiChat/replies";
import { chatBuffers, resetAiChatMemoryCache } from "../../../packages/cache/aiChat/memory";
import { QUEUED_TRIGGER_SNIPPET_MAX_CHARS, REPLY_ROUND_MAX_CONCURRENT } from "../../../packages/consts/aiChat";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import type { BufferedMessage, QueuedReplyTrigger } from "../../../packages/types";
import { drainReplyQueue, pushReplyTrigger, triggerKindFor } from "../../../packages/workers/aiChat/replyQueue";
import { indexBufferedMessage } from "../../../packages/workers/aiChat/replyChain";

afterEach(() => {
  resetAiChatReplyCache();
  resetAiChatMemoryCache();
});

describe("AI 回复触发队列", () => {
  test("按随机、直接媒体和随机媒体分类", () => {
    const media = { kind: "photo" as const, senderId: 1, senderName: "Alice", description: "一张图" };
    expect(triggerKindFor(true, undefined)).toBe("random");
    expect(triggerKindFor(true, { ...media, directTriggerReason: "mention" })).toBe("random");
    expect(triggerKindFor(false, undefined)).toBe("direct");
    expect(triggerKindFor(false, media)).toBe("mediaRandom");
    expect(triggerKindFor(false, { ...media, directTriggerReason: "reply" })).toBe("mediaDirect");
  });

  test("文本触发快照按 replyToMessageId 定位触发消息，不取缓冲尾条", () => {
    // 主线程把 record 与 trigger 作为两条独立消息投过来，两者之间在途轮次的
    // onMessageSent 完全可能把机器人自己的消息推进 chatBuffers。取尾条的话，
    // 排队轮的提示词会渲染成「XX 也在跟你说话（TA 说的是：「机器人上一句」）」
    // ——模型对着自己编造的内容回复。
    const messages = new LinkedQueue<BufferedMessage>();
    const older: BufferedMessage = { messageId: 87, id: 1, firstName: "Older", lastName: "", text: "旧消息", at: "" };
    const trigger: BufferedMessage = {
      messageId: 88,
      id: 2,
      firstName: "Alice",
      lastName: "Chen",
      text: "x".repeat(QUEUED_TRIGGER_SNIPPET_MAX_CHARS + 20),
      forwardedFrom: "频道 [id:-100666] 东京日报",
      replyTo: { messageId: 70, id: 4, firstName: "Carol", lastName: "", text: "原问题" },
      at: "",
    };
    // 触发消息之后又落进来一条机器人自己的发言：尾条从此不再是触发消息。
    const selfSent: BufferedMessage = { messageId: 89, id: 99, firstName: "Ninjia", lastName: "", text: "本天才刚说的话", at: "" };
    for (const entry of [older, trigger, selfSent]) {
      messages.push(entry);
      indexBufferedMessage(-1001, entry);
    }
    chatBuffers.set(-1001, messages);

    pushReplyTrigger({
      chatId: -1001,
      triggerSenderId: 2,
      replyToMessageId: 88,
      imageGenerationRequested: true,
      imageGenerationReference: { fileId: "reply-photo", fileUniqueId: "reply-photo-unique", width: 1280, height: 960 },
    });

    expect(pendingReplyTriggers.get(-1001)?.shift()).toEqual({
      replyToMessageId: 88,
      triggerSenderId: 2,
      triggerReference: {
        messageId: 88,
        id: 2,
        firstName: "Alice",
        lastName: "Chen",
        text: "x".repeat(QUEUED_TRIGGER_SNIPPET_MAX_CHARS + 20),
        forwardedFrom: "频道 [id:-100666] 东京日报",
      },
      replyTo: { messageId: 70, id: 4, firstName: "Carol", lastName: "", text: "原问题" },
      forwardedFrom: "频道 [id:-100666] 东京日报",
      imageGenerationRequested: true,
      imageGenerationReference: { fileId: "reply-photo", fileUniqueId: "reply-photo-unique", width: 1280, height: 960 },
      senderName: "Alice Chen",
      text: "x".repeat(QUEUED_TRIGGER_SNIPPET_MAX_CHARS),
    });
  });

  test("媒体触发使用解析结果快照，不依赖缓存尾部", () => {
    pushReplyTrigger({
      chatId: -1001,
      triggerSenderId: 3,
      replyToMessageId: 89,
      imageGenerationRequested: true,
      mediaTrigger: {
        kind: "animation",
        senderId: 3,
        senderName: "Bob",
        description: "挥手",
        triggerText: "[GIF：挥手] @bot 把它画成像素风",
        triggerReference: {
          messageId: 89,
          id: 3,
          firstName: "Bob",
          lastName: "",
          text: "[GIF：挥手] @bot 把它画成像素风",
          forwardedFrom: "[id:6] Eve",
        },
        forwardedFrom: "[id:6] Eve",
        directTriggerReason: "mention",
        replyTo: { messageId: 71, id: 5, firstName: "Dave", lastName: "", text: "[图片]" },
      },
    });

    expect(pendingReplyTriggers.get(-1001)?.shift()).toEqual({
      replyToMessageId: 89,
      triggerSenderId: 3,
      triggerReference: {
        messageId: 89,
        id: 3,
        firstName: "Bob",
        lastName: "",
        text: "[GIF：挥手] @bot 把它画成像素风",
        forwardedFrom: "[id:6] Eve",
      },
      replyTo: { messageId: 71, id: 5, firstName: "Dave", lastName: "", text: "[图片]" },
      forwardedFrom: "[id:6] Eve",
      imageGenerationRequested: true,
      senderName: "Bob",
      text: "[GIF：挥手] @bot 把它画成像素风",
    });
  });

  test("按 FIFO 补跑，并在回调占满并发位后保留剩余项", () => {
    const queue = new LinkedQueue<QueuedReplyTrigger>();
    queue.push({ triggerSenderId: 1, replyToMessageId: 1, imageGenerationRequested: false, senderName: "A", text: "first" });
    queue.push({ triggerSenderId: 2, replyToMessageId: 2, imageGenerationRequested: true, senderName: "B", text: "second" });
    pendingReplyTriggers.set(-1001, queue);
    activeReplyCounts.set(-1001, REPLY_ROUND_MAX_CONCURRENT - 1);
    const started: number[] = [];

    drainReplyQueue(-1001, (trigger: QueuedReplyTrigger): boolean => {
      started.push(trigger.replyToMessageId);
      activeReplyCounts.set(-1001, REPLY_ROUND_MAX_CONCURRENT);
      return true;
    });

    expect(started).toEqual([1]);
    expect(pendingReplyTriggers.get(-1001)?.peek()?.replyToMessageId).toBe(2);
  });

  test("被限频拒绝时停下并把这条留在队首，不整队丢弃", () => {
    // 限频闸只看这个群 5 分钟窗口内的轮数，跟具体是哪一条触发无关：第一条被拒
    // 就意味着后面每一条都会被拒。而被拒时并发计数不增长，循环条件永远为真——
    // 继续往下走就是在同一个同步 tick 里把整队 @提及/回复 shift 掉全部丢弃，
    // 那些人一句回复都收不到。
    const queue = new LinkedQueue<QueuedReplyTrigger>();
    for (let index: number = 1; index <= 3; index++) {
      queue.push({ triggerSenderId: index, replyToMessageId: index, imageGenerationRequested: false, senderName: "A", text: "x" });
    }
    pendingReplyTriggers.set(-1001, queue);
    activeReplyCounts.delete(-1001);
    const attempted: number[] = [];

    drainReplyQueue(-1001, (trigger: QueuedReplyTrigger): boolean => {
      attempted.push(trigger.replyToMessageId);
      return false;
    });

    expect(attempted).toEqual([1]);
    expect(pendingReplyTriggers.get(-1001)?.size).toBe(3);
    expect(pendingReplyTriggers.get(-1001)?.peek()?.replyToMessageId).toBe(1);
  });
});
