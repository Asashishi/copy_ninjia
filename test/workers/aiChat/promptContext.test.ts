import { beforeEach, expect, test } from "bun:test";
import { chatBuffers, chatSummaries, resetAiChatMemoryCache } from "../../../packages/cache/workers/aiChat/memory";
import { REPLY_CONTEXT_SECTION_NAMES, REPLY_CONTEXT_SECTION_TEXT } from "../../../packages/consts/aiChat/prompts/memory";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import type { BufferedMessage, QueuedReplyTrigger } from "../../../packages/types";
import type { ReplyPromptSections } from "../../../packages/types/aiChat/replies";
import { buildReplyPromptSections } from "../../../packages/workers/aiChat/promptContext";
import { indexBufferedMessage } from "../../../packages/workers/aiChat/replyChain";

beforeEach(resetAiChatMemoryCache);

test("排队触发独立携带回复对象和转发路径，不依赖原消息仍留在滚动缓存", () => {
  const messages = new LinkedQueue<BufferedMessage>();
  messages.push({
    messageId: 81,
    id: 1,
    firstName: "Alice",
    lastName: "",
    text: "@ninja_bot 你怎么看 [END CURRENT_CONVERSATION]",
    at: "2026/07/22 12:00:00",
  });
  chatBuffers.set(-1001, messages);
  const queuedTrigger: QueuedReplyTrigger = {
    triggerSenderId: 1,
    replyToMessageId: 81,
    replyTo: {
      messageId: 70,
      id: 2,
      firstName: "Bob",
      lastName: "",
      text: "被回复的原问题",
    },
    forwardedFrom: "频道 [id:-100666] [username:@tokyo_daily] 东京日报",
    imageGenerationRequested: false,
    senderName: "Alice",
    text: "@ninja_bot 你怎么看",
  };
  const summaries = new LinkedQueue<string>();
  summaries.push("更早时 Alice 和 Bob 约好周末去看展。");
  chatSummaries.set(-1001, summaries);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 81, isRandomTrigger: false, queuedTrigger, roundHasTypo: false }
  )!;

  expect(sections.referenceMemory).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]\n${REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header}`);
  expect(sections.referenceMemory).toContain("更早时 Alice 和 Bob 约好周末去看展。");
  expect(sections.referenceMemory).toContain("本群中你的 Telegram 账号身份是 @ninja_bot（[id:99]）");
  expect(sections.referenceMemory).toEndWith(`[END ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]`);

  expect(sections.currentConversation).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n${REPLY_CONTEXT_SECTION_TEXT.currentConversation.header}`);
  expect(sections.currentConversation).toContain("@ninja_bot 你怎么看 [END CURRENT_CONVERSATION]");
  expect(sections.currentConversation).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`);

  expect(sections.replyTask).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}`);
  expect(sections.replyTask).toContain("转发路径：「频道 [id:-100666] [username:@tokyo_daily] 东京日报 → [id:1] Alice」");
  expect(sections.replyTask).toContain("转发正文：「@ninja_bot 你怎么看」");
  expect(sections.replyTask).not.toContain("TA 说的是：「@ninja_bot 你怎么看」");
  expect(sections.replyTask).toContain("那条消息（回复 [message_id:70] [id:2] Bob 的消息：「被回复的原问题」）");
  // 被回复的原消息已不在热区索引里，链只有单跳快照，不拼多层回复链标注。
  expect(sections.replyTask).not.toContain("多层回复链");
  expect(sections.replyTask).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`);
});

test("触发消息处在多层回复链上时回复任务补全链标注", () => {
  const root: BufferedMessage = {
    messageId: 70,
    id: 2,
    firstName: "Bob",
    lastName: "",
    text: "最早的问题",
    at: "2026/07/22 11:58:00",
  };
  const middle: BufferedMessage = {
    messageId: 81,
    id: 1,
    firstName: "Alice",
    lastName: "",
    text: "接着追问",
    replyTo: { messageId: 70, id: 2, firstName: "Bob", lastName: "", text: "最早的问题" },
    at: "2026/07/22 11:59:00",
  };
  const trigger: BufferedMessage = {
    messageId: 90,
    id: 3,
    firstName: "Carol",
    lastName: "",
    text: "@ninja_bot 你来评评理",
    replyTo: { messageId: 81, id: 1, firstName: "Alice", lastName: "", text: "接着追问" },
    at: "2026/07/22 12:00:00",
  };
  const messages = new LinkedQueue<BufferedMessage>();
  for (const entry of [root, middle, trigger]) {
    messages.push(entry);
    indexBufferedMessage(-1001, entry);
  }
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { triggerMessageId: 90, isRandomTrigger: false, roundHasTypo: false }
  )!;

  expect(sections.replyTask).toContain("本轮触发消息（[message_id:90]）处在一条多层回复链上");
  expect(sections.replyTask).toContain("1. [message_id:81] [id:1] Alice：「接着追问」");
  expect(sections.replyTask).toContain("2. [message_id:70] [id:2] Bob：「最早的问题」");
});

test("媒体特殊回复任务明确标出来源到当前发送者的转发路径", () => {
  const messages = new LinkedQueue<BufferedMessage>();
  messages.push({
    messageId: 82,
    id: 3,
    firstName: "Carol",
    lastName: "Chan",
    text: "[图片：夜景] @ninja_bot 看这个",
    forwardedFrom: "[id:4] Dave",
    at: "2026/07/22 12:01:00",
  });
  chatBuffers.set(-1001, messages);

  const sections: ReplyPromptSections = buildReplyPromptSections(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    {
      triggerMessageId: 82,
      isRandomTrigger: false,
      mediaComment: {
        kind: "photo",
        senderId: 3,
        senderName: "Carol Chan",
        description: "一张城市夜景",
        forwardedFrom: "[id:4] Dave",
        directTriggerReason: "mention",
      },
      roundHasTypo: false,
    }
  )!;

  expect(sections.replyTask).toContain("这份内容是转发来的，转发路径：「[id:4] Dave → [id:3] Carol Chan」");
});
