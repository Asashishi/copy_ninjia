import { beforeEach, expect, test } from "bun:test";
import { chatBuffers, resetAiChatMemoryCache } from "../../../src/cache/aiChat/memory";
import { LinkedQueue } from "../../../src/libs/linkedQueue";
import type { BufferedMessage, QueuedReplyTrigger } from "../../../src/types";
import { buildUserContent } from "../../../src/workers/aiChat/promptContext";

beforeEach(resetAiChatMemoryCache);

test("排队触发独立携带 replyTo，不依赖原消息仍留在滚动缓存", () => {
  const messages = new LinkedQueue<BufferedMessage>();
  messages.push({
    messageId: 81,
    id: 1,
    firstName: "Alice",
    lastName: "",
    text: "@ninja_bot 你怎么看",
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

  const content: string = buildUserContent(
    -1001,
    { id: 99, first_name: "Ninja", username: "ninja_bot" },
    { isRandomTrigger: false, queuedTrigger, roundHasTypo: false }
  )!;

  expect(content).toContain("那条消息（回复 [message_id:70] [id:2] Bob 的消息：「被回复的原问题」）");
});
