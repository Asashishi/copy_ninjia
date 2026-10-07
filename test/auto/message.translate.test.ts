import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  autoMessageChatState,
  autoMessageCopyState,
  copyMessageMock,
  generateAndSendReplyMock,
  recordChatMessageMock,
  resetAutoMessageMocks,
  autoMessageTranslateSessions,
  sendMessageMock,
} from "../helpers/autoMessageMocks";

const translateText = mock(async (..._args: unknown[]): Promise<string> => "こんにちは");
mock.module("../../packages/translate/client", () => ({ translateText }));
const { handleIncomingMessageMiddleware } = await import("../../packages/auto/message");
const { translateMessageBacklogs, translateMessageChains, translateRuntime } = await import("../../packages/cache/main/translate");
const { TRANSLATE_CHAT_BACKLOG_MAX } = await import("../../packages/consts/translate");
const { logger } = await import("../../packages/infra/logger");

/** 处理一条消息并等后台译文链结算：译文在 update 之外按群串行发出。 */
async function handleAndSettle(ctx: never): Promise<void> {
  await handleIncomingMessageMiddleware(ctx);
  await Promise.allSettled([...translateRuntime.tasks]);
}

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
  autoMessageTranslateSessions.clear();
  autoMessageTranslateSessions.set(-1001, [{ translatedUser: { id: 7 }, language: "ja" }]);
  translateText.mockClear();
});

describe("复读接管时的 AI 分流", () => {
  test("本群有复读目标时，其他人的消息不进 AI 触发（不记录、不回复）", async () => {
    autoMessageTranslateSessions.clear();
    autoMessageCopyState.targetId = 123;
    const ctx = context(9) as any;
    ctx.msg.text = "@test_bot 你好";
    await handleAndSettle(ctx as never);

    expect(recordChatMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
    expect(copyMessageMock).not.toHaveBeenCalled();

    autoMessageCopyState.targetId = undefined;
    await handleAndSettle(ctx as never);
    expect(recordChatMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe("群消息翻译分流", () => {
  test("同群多个目标分别使用自己的语言，非目标不翻译", async () => {
    autoMessageTranslateSessions.set(-1001, [
      { translatedUser: { id: 7 }, language: "uk" },
      { translatedUser: { id: 8 }, language: "ru" },
    ]);
    await handleAndSettle(context(7));
    await handleAndSettle(context(8));
    await handleAndSettle(context(9));
    expect(translateText.mock.calls).toEqual([["你好", "uk"], ["你好", "ru"]]);
  });

  test("只翻译本群目标，使用现有话题路由", async () => {
    await handleAndSettle(context(7));
    expect(translateText).toHaveBeenCalledWith("你好", "ja");
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "こんにちは", messageThreadId: 42 });
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("译文在后台按群串行发出：update 不等翻译，同群后到的消息排在前一条译文之后", async () => {
    const releases: (() => void)[] = [];
    translateText.mockImplementation((text: unknown): Promise<string> =>
      new Promise((resolve: (value: string) => void): void => { releases.push((): void => resolve(`译:${String(text)}`)); }));
    try {
      const first = context(7) as any;
      const second = context(7) as any;
      second.msg.text = "再见";
      await handleIncomingMessageMiddleware(first as never);
      await handleIncomingMessageMiddleware(second as never);
      // 两条 update 都已返回，译文仍在等 RPC；同群第二条排在第一条之后，还没开始翻译。
      await Bun.sleep(0);
      expect(releases).toHaveLength(1);
      expect(sendMessageMock).not.toHaveBeenCalled();
      releases[0]!();
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(releases).toHaveLength(2);
      releases[1]!();
      await Promise.allSettled([...translateRuntime.tasks]);
      expect(sendMessageMock.mock.calls.map((call: unknown[]): unknown => (call[0] as { text: string }).text))
        .toEqual(["译:你好", "译:再见"]);
      expect(translateMessageChains.size).toBe(0);
    } finally {
      translateText.mockImplementation(async (): Promise<string> => "こんにちは");
    }
  });

  test("同群积压达到上限时新消息不翻译，同一段积压只记一次日志，排空后删除积压条目", async () => {
    const releaseFirst: PromiseWithResolvers<string> = Promise.withResolvers<string>();
    translateText.mockImplementationOnce((): Promise<string> => releaseFirst.promise);
    const loggerError = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      for (let index: number = 0; index < TRANSLATE_CHAT_BACKLOG_MAX + 2; index++) {
        await handleIncomingMessageMiddleware(context(7));
      }
      expect(translateMessageBacklogs.get(-1001)?.count).toBe(TRANSLATE_CHAT_BACKLOG_MAX);
      expect(loggerError).toHaveBeenCalledTimes(1);
      releaseFirst.resolve("こんにちは");
      await Promise.allSettled([...translateRuntime.tasks]);
      expect(translateText).toHaveBeenCalledTimes(TRANSLATE_CHAT_BACKLOG_MAX);
      expect(translateMessageBacklogs.size).toBe(0);
    } finally {
      loggerError.mockRestore();
    }
  });

  test("本群其它人和另一群同一人不进入翻译", async () => {
    await handleAndSettle(context(8));
    await handleAndSettle(context(7, -2002));
    expect(translateText).not.toHaveBeenCalled();
  });

  test("翻译和 copy 可同时盯不同人，同一目标优先完成翻译且只发送一次", async () => {
    autoMessageCopyState.targetId = 8;
    await handleAndSettle(context(8));
    // 复读按字符串重新发送原文，不原样复制。
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "你好", messageThreadId: 42 });
    expect(translateText).not.toHaveBeenCalled();
    sendMessageMock.mockClear();
    autoMessageCopyState.targetId = 7;
    await handleAndSettle(context(7));
    expect(translateText).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "こんにちは", messageThreadId: 42 });
    expect(copyMessageMock).not.toHaveBeenCalled();
  });

  test("翻译关闭后 copy 目标仍按 copy 处理", async () => {
    autoMessageChatState.isTranslationEnabled = false;
    autoMessageCopyState.targetId = 7;
    await handleAndSettle(context(7));
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "你好", messageThreadId: 42 });
    expect(translateText).not.toHaveBeenCalled();
  });

  test("翻译目标的图片同时命中 copy 时只发图注译文：图片不复制，不回落到 AI", async () => {
    autoMessageCopyState.targetId = 7;
    const ctx = context(7) as any;
    delete ctx.msg.text;
    ctx.msg.photo = [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }];
    ctx.msg.caption = "你好";
    await handleAndSettle(ctx as never);
    expect(translateText).toHaveBeenCalledWith("你好", "ja");
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({ chatId: -1001, text: "こんにちは", messageThreadId: 42 });
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test.each(["copy", "none"])("翻译目标（copy 目标：%s）的同语种文字、无图注图片与贴纸整条不反应", async (copy: string) => {
    if (copy === "copy") autoMessageCopyState.targetId = 7;
    const sameLanguage = context(7) as any;
    sameLanguage.msg.text = "こんにちは";
    const photo = context(7) as any;
    delete photo.msg.text;
    photo.msg.photo = [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }];
    const sticker = context(7) as any;
    delete sticker.msg.text;
    sticker.msg.sticker = { file_id: "f", file_unique_id: "u", type: "regular", width: 1, height: 1, is_animated: false, is_video: false };
    for (const ctx of [sameLanguage, photo, sticker]) await handleAndSettle(ctx as never);
    expect(translateText).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(copyMessageMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("频道马甲按可见身份匹配翻译目标", async () => {
    autoMessageTranslateSessions.set(-1001, [{ translatedUser: { id: -3003, isChannel: true }, language: "ja" }]);
    const ctx = context(8) as any;
    ctx.msg.sender_chat = { id: -3003, type: "channel", title: "Channel" };
    await handleAndSettle(ctx as never);
    expect(translateText).toHaveBeenCalledTimes(1);
  });
});
