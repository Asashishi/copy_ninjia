import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  autoMessageChatState,
  autoMessageCopyState,
  copyMessageMock,
  generateAndSendReplyMock,
  resetAutoMessageMocks,
  sendMessageMock,
} from "../helpers/autoMessageMocks";
import { translateStates } from "../../packages/cache/main/translateState";

const translateText = mock(async (..._args: unknown[]): Promise<string> => "こんにちは");
mock.module("../../packages/translate/client", () => ({ translateText }));
const { handleIncomingMessageMiddleware } = await import("../../packages/auto/message");

function context(senderId: number, chatId: number = -1001): never {
  return {
    me: { id: 999, username: "test_bot", first_name: "Bot" },
    msg: {
      message_id: 5, date: 1,
      chat: { id: chatId, type: "supergroup", title: "Test", is_forum: true },
      from: { id: senderId, is_bot: false, first_name: "Target" },
      text: "你好", is_topic_message: true, message_thread_id: 42,
    },
  } as never;
}

beforeEach(() => {
  resetAutoMessageMocks();
  autoMessageChatState.isTranslationEnabled = true;
  translateStates.clear();
  translateStates.set(-1001, [{ translatedUser: { id: 7 }, language: "ja" }]);
  translateText.mockClear();
});

describe("群消息翻译分流", () => {
  test("同群多个目标分别使用自己的语言，非目标不翻译", async () => {
    translateStates.set(-1001, [
      { translatedUser: { id: 7 }, language: "uk" },
      { translatedUser: { id: 8 }, language: "ru" },
    ]);
    await handleIncomingMessageMiddleware(context(7));
    await handleIncomingMessageMiddleware(context(8));
    await handleIncomingMessageMiddleware(context(9));
    expect(translateText.mock.calls).toEqual([["你好", "uk"], ["你好", "ru"]]);
  });

  test("只翻译本群目标，使用现有话题路由", async () => {
    await handleIncomingMessageMiddleware(context(7));
    expect(translateText).toHaveBeenCalledWith("你好", "ja");
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "こんにちは", messageThreadId: 42 });
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("本群其它人和另一群同一人不进入翻译", async () => {
    await handleIncomingMessageMiddleware(context(8));
    await handleIncomingMessageMiddleware(context(7, -2002));
    expect(translateText).not.toHaveBeenCalled();
  });

  test("翻译和 copy 可同时盯不同人，同一目标优先完成翻译且只发送一次", async () => {
    autoMessageCopyState.targetId = 8;
    await handleIncomingMessageMiddleware(context(8));
    expect(copyMessageMock).toHaveBeenCalledTimes(1);
    expect(translateText).not.toHaveBeenCalled();
    copyMessageMock.mockClear();
    autoMessageCopyState.targetId = 7;
    await handleIncomingMessageMiddleware(context(7));
    expect(translateText).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(copyMessageMock).not.toHaveBeenCalled();
  });

  test("翻译关闭后 copy 目标仍按 copy 处理", async () => {
    autoMessageChatState.isTranslationEnabled = false;
    autoMessageCopyState.targetId = 7;
    await handleIncomingMessageMiddleware(context(7));
    expect(copyMessageMock).toHaveBeenCalledTimes(1);
    expect(translateText).not.toHaveBeenCalled();
  });

  test("翻译目标的图片即使同时命中 copy 也不复制图注或回落到 AI", async () => {
    autoMessageCopyState.targetId = 7;
    const ctx = context(7) as any;
    delete ctx.msg.text;
    ctx.msg.photo = [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }];
    ctx.msg.caption = "你好";
    await handleIncomingMessageMiddleware(ctx);
    expect(translateText).not.toHaveBeenCalled();
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("频道马甲按可见身份匹配翻译目标", async () => {
    translateStates.set(-1001, [{ translatedUser: { id: -3003, isChannel: true }, language: "ja" }]);
    const ctx = context(8) as any;
    ctx.msg.sender_chat = { id: -3003, type: "channel", title: "Channel" };
    await handleIncomingMessageMiddleware(ctx);
    expect(translateText).toHaveBeenCalledTimes(1);
  });
});
