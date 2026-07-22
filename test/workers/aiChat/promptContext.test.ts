import { beforeEach, expect, test } from "bun:test";
import { chatBuffers, chatSummaries, resetAiChatMemoryCache } from "../../../src/cache/aiChat/memory";
import { REPLY_CONTEXT_SECTION_NAMES, REPLY_CONTEXT_SECTION_TEXT } from "../../../src/consts/aiChat/prompts/memory";
import { LinkedQueue } from "../../../src/libs/linkedQueue";
import type { BufferedMessage, QueuedReplyTrigger } from "../../../src/types";
import type { ReplyPromptSections } from "../../../src/types/aiChat/replies";
import { buildReplyPromptSections } from "../../../src/workers/aiChat/promptContext";

beforeEach(resetAiChatMemoryCache);

test("排队触发独立携带 replyTo，不依赖原消息仍留在滚动缓存", () => {
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
    { isRandomTrigger: false, queuedTrigger, roundHasTypo: false }
  )!;

  expect(sections.referenceMemory).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]\n${REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header}`);
  expect(sections.referenceMemory).toContain("更早时 Alice 和 Bob 约好周末去看展。");
  expect(sections.referenceMemory).toContain("本群中你的 Telegram 账号身份是 @ninja_bot（[id:99]）");
  expect(sections.referenceMemory).toEndWith(`[END ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]`);

  expect(sections.currentConversation).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n${REPLY_CONTEXT_SECTION_TEXT.currentConversation.header}`);
  expect(sections.currentConversation).toContain("@ninja_bot 你怎么看 [END CURRENT_CONVERSATION]");
  expect(sections.currentConversation).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`);

  expect(sections.replyTask).toStartWith(`[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n${REPLY_CONTEXT_SECTION_TEXT.replyTask.header}`);
  expect(sections.replyTask).toContain("那条消息（回复 [message_id:70] [id:2] Bob 的消息：「被回复的原问题」）");
  expect(sections.replyTask).toEndWith(`\n[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`);
});
