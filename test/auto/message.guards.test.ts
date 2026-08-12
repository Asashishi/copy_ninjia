import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import { LUCK_RECEIPT_DISPLAY_PREFIX } from "../../packages/consts/luckReceipt";
import type { AiBotInfo, AiRecordMessage } from "../../packages/types/aiChat/protocol";

const recorded: AiRecordMessage[] = [];
let aiActive: boolean = true;
let copyActive: boolean = false;

mock.module("../../packages/aiChat", () => ({
  recordChatMessage: (message: AiRecordMessage): void => { recorded.push(message); },
}));
mock.module("../../packages/aiChat/availability", () => ({
  isAiChatActiveIn: (_chatId: number): boolean => aiActive,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getActiveCopyIn: (_chatId: number): boolean => copyActive,
}));

const { recordSelfInlineResult } = await import("../../packages/auto/message/guards");

const bot: AiBotInfo = { id: 99, username: "ninja_bot", first_name: "Ninja" };

function message(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 17,
    date: 1_786_447_200,
    chat: { id: -1001, type: "supergroup", title: "test" },
    text: "可读正文",
    ...overrides,
  } as Message;
}

beforeEach((): void => {
  recorded.length = 0;
  aiActive = true;
  copyActive = false;
});

describe("inline 结果自录门禁", () => {
  test("AI 活跃群只记录可读正文，不把运势回执混进模型上下文", () => {
    recordSelfInlineResult(message({
      text: `可读正文\n${LUCK_RECEIPT_DISPLAY_PREFIX}${"a".repeat(64)}`,
    }), bot);

    expect(recorded).toEqual([{
      type: "record",
      chatId: -1001,
      senderId: 99,
      firstName: "Ninja",
      lastName: "",
      username: "ninja_bot",
      messageId: 17,
      replyTo: undefined,
      forwardedFrom: undefined,
      persistImmediately: false,
      text: "可读正文",
    }]);
  });

  test("私聊、非文本、复读接管或 AI 未启用时都不自录", () => {
    recordSelfInlineResult(message({
      chat: { id: 7, type: "private", first_name: "Alice" },
    }), bot);
    recordSelfInlineResult(message({ text: undefined }), bot);
    copyActive = true;
    recordSelfInlineResult(message(), bot);
    copyActive = false;
    aiActive = false;
    recordSelfInlineResult(message(), bot);

    expect(recorded).toEqual([]);
  });
});
