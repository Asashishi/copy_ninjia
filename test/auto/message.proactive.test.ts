import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import type { AiBotInfo } from "../../packages/types/aiChat/protocol";

const sendMessageMock = mock(
  async (..._args: unknown[]): Promise<number | undefined> => 91
);
const recordChatMessageMock = mock((..._args: unknown[]): void => {});
const echoMessageMock = mock(
  async (..._args: unknown[]): Promise<string | undefined> => "echoed"
);
const resolveEffectiveCopyModeMock = mock(
  (..._args: unknown[]): undefined => undefined
);

mock.module("../../packages/infra/telegram", () => ({
  sendMessage: sendMessageMock,
}));
mock.module("../../packages/aiChat", () => ({
  recordChatMessage: recordChatMessageMock,
}));
mock.module("../../packages/auto/message/echo", () => ({
  echoMessage: echoMessageMock,
  resolveEffectiveCopyMode: resolveEffectiveCopyModeMock,
}));

const { handleProactiveMessageActions } =
  await import("../../packages/auto/message/proactive");

const CHAT_ID: number = -1001;
const bot: AiBotInfo = {
  id: 999,
  first_name: "TestBot",
  username: "test_bot",
};

function messageFixture(overrides: Partial<Message>): Message {
  return {
    message_id: 7,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
    ...overrides,
  } as Message;
}

beforeEach((): void => {
  sendMessageMock.mockClear();
  recordChatMessageMock.mockClear();
  echoMessageMock.mockClear();
  resolveEffectiveCopyModeMock.mockClear();
});

describe("群消息主动行为", () => {
  test("无触发的普通消息同步返回，不创建异步工作", () => {
    const action: Promise<void> | undefined = handleProactiveMessageActions({
      message: messageFixture({}),
      bot,
      isQuiet: false,
      aiChatEnabled: false,
    });

    expect(action).toBeUndefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(echoMessageMock).not.toHaveBeenCalled();
  });

  test("洗澡触发仍等待发送完成，并在 AI 开启时记录机器人回复", async () => {
    const action: Promise<void> | undefined = handleProactiveMessageActions({
      message: messageFixture({ text: "洗澡" }),
      bot,
      isQuiet: false,
      aiChatEnabled: true,
    });

    expect(action).toBeInstanceOf(Promise);
    await action;
    expect(sendMessageMock).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      text: "看看",
      replyToMessageId: 7,
    });
    expect(recordChatMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "record",
      chatId: CHAT_ID,
      senderId: bot.id,
      messageId: 91,
      text: "看看",
    }));
  });

  test("随机复读命中仍返回完成 Promise，并吸收底层消息标识", async () => {
    const originalRandom: () => number = Math.random;
    Math.random = (): number => 0;
    try {
      const message: Message = messageFixture({
        document: { file_id: "file", file_unique_id: "unique" },
      });
      const action: Promise<void> | undefined = handleProactiveMessageActions({
        message,
        bot,
        isQuiet: false,
        aiChatEnabled: false,
      });

      expect(action).toBeInstanceOf(Promise);
      await action;
      expect(resolveEffectiveCopyModeMock).toHaveBeenCalledTimes(1);
      expect(echoMessageMock).toHaveBeenCalledWith({
        chatId: CHAT_ID,
        message,
        mode: undefined,
      });
    } finally {
      Math.random = originalRandom;
    }
  });
});
