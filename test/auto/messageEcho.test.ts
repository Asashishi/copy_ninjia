import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "grammy/types";

/**
 * 复读边界（packages/auto/message/echo.ts）的「不回显命令」这道闸。
 *
 * 它守的是一件很具体的事：机器人自己发出去的那一份副本会被 Telegram 渲染成
 * 可点击的命令链接。只看 message.text 的话，媒体消息的 caption 会整条绕过这
 * 道闸——`/copy` 锁定的人发一张 caption 写着 `/batch_kick 1d` 的图，机器人就
 * 亲手替一条破坏性管理命令造了个一键入口。
 */

const copyMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 77);
const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 78);

mock.module("../../packages/infra/telegram", () => ({ copyMessage, sendMessage }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  activeCopyTargetIdIn: (): undefined => undefined,
  activeCopyModeIn: (): undefined => undefined,
}));

const { echoMessage } = await import("../../packages/auto/message/echo");

const CHAT_ID: number = -1001;

/** 只带本用例关心的字段；echoMessage 读的就是 text / caption / message_id。 */
function mediaMessage(caption: string | undefined): Message {
  return {
    message_id: 5,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
    photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
    ...(caption === undefined ? {} : { caption }),
  } as unknown as Message;
}

beforeEach(() => {
  copyMessage.mockClear();
  sendMessage.mockClear();
});

describe("复读的话题落点", () => {
  // 复读不挂回复，话题群里缺了 message_thread_id 就会掉进 General：被复读的人
  // 在自己话题里说话，本天才却在 General 学舌（见 libs/forumTopic.ts）。
  test("媒体复读把话题带给 copyMessage", async () => {
    await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage("今天天气不错"),
      mode: undefined,
      messageThreadId: 42,
    });

    expect(copyMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      fromChatId: CHAT_ID,
      messageId: 5,
      messageThreadId: 42,
      caption: "今天天气不错",
      showCaptionAboveMedia: undefined,
      videoStartTimestamp: undefined,
    });
  });

  test("文本变换复读把话题带给 sendMessage", async () => {
    await echoMessage({
      chatId: CHAT_ID,
      message: {
        message_id: 6,
        date: 1,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
        text: "今天天气不错",
      } as unknown as Message,
      mode: "nya",
      messageThreadId: 42,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      text: "今天天气不错 喵~",
      messageThreadId: 42,
    });
  });
});

describe("复读的命令守卫", () => {
  test("caption 是命令的媒体消息不复读", async () => {
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage("/batch_kick 1d"),
      mode: undefined,
    });

    expect(echoed).toBeUndefined();
    expect(copyMessage).not.toHaveBeenCalled();
  });

  test("caption 不是命令的媒体消息照常复读", async () => {
    await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage("今天天气不错"),
      mode: undefined,
    });

    expect(copyMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 5, caption: "今天天气不错" }));
  });

  test("没有 caption 的媒体消息照常复读", async () => {
    await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage(undefined),
      mode: undefined,
    });

    expect(copyMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      fromChatId: CHAT_ID,
      messageId: 5,
      messageThreadId: undefined,
    });
  });

  test("命令不在行首的 caption 同样不复读", async () => {
    // 带 bot_command 实体的消息拿不到 plainText，会落到 copyMessage 分支；
    // 因此入口必须检查整段 caption，而不能只检查开头或依赖变换后守卫。
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage("看这个 /batch_kick 1d"),
      mode: undefined,
    });

    expect(echoed).toBeUndefined();
    expect(copyMessage).not.toHaveBeenCalled();
  });

  test("命令不在行首的带 entity 文本同样不复读", async () => {
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
        text: "喵 /batch_kick 1d",
        entities: [{ type: "bot_command", offset: 2, length: 11 }],
      } as unknown as Message,
      mode: undefined,
    });

    expect(echoed).toBeUndefined();
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("正文里的斜杠不构成命令时照常复读", async () => {
    // 守卫收紧后不能把 `and/or`、`http://x` 这类日常正文一起误伤。
    await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage("要么 a/b 要么 c"),
      mode: undefined,
    });

    expect(copyMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 5, caption: "要么 a/b 要么 c" }));
  });

  test("纯文本命令仍然不复读", async () => {
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: {
        message_id: 6,
        date: 1,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
        text: "/block 123",
      } as unknown as Message,
      mode: undefined,
    });

    expect(echoed).toBeUndefined();
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

/** 纯文字消息。 */
function plainTextMessage(text: string): Message {
  return {
    message_id: 9,
    date: 1,
    chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
    text,
  } as unknown as Message;
}

describe("变换之后的文本同样要过命令守卫", () => {
  test("reverse 把普通文本倒成行首命令时整条丢弃", async () => {
    // 原文不以 `/` 开头，只对原文判定的守卫会放行；真正发出去的却是
    // `/batch_kick 1d`，Telegram 会把它渲染成可点击的批量踢人链接。
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: plainTextMessage("d1 kcik_hctab/"),
      mode: "reverse",
    });

    expect(echoed).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(copyMessage).not.toHaveBeenCalled();
  });

  test("命令被空白顶到第二位同样丢弃：bot_command 不只认行首", async () => {
    // 只判 startsWith("/") 的话，原文末尾多打一个空格就能绕过去。
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: plainTextMessage("d1 kcik_hctab/ "),
      mode: "reverse",
    });

    expect(echoed).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("变换结果里的 `/` 不构成命令时照常发出", async () => {
    // 斜杠后面不是命令名的首字符，Telegram 不会渲染成命令。
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: plainTextMessage("b/a"),
      mode: "reverse",
    });

    expect(echoed).toBe("a/b");
    expect(sendMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: "a/b" });
  });
});

describe("文字与图注一律按字符串处理", () => {
  test("带链接与 @ 的文字照样变换，按字符串发送，不再原样复制；原消息的预览设置照搬", async () => {
    const echoed: string | undefined = await echoMessage({
      chatId: CHAT_ID,
      message: {
        ...plainTextMessage("看 https://example.com @alice"),
        entities: [{ type: "url", offset: 2, length: 19 }, { type: "mention", offset: 22, length: 6 }],
        link_preview_options: { is_disabled: true },
      } as unknown as Message,
      mode: "nya",
      messageThreadId: 3,
    });
    expect(echoed).toBe("看 https://example.com @alice 喵~");
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID, text: "看 https://example.com @alice 喵~", messageThreadId: 3, linkPreviewOptions: { is_disabled: true },
    });
  });

  test("没有模式的纯文字同样按字符串重新发送", async () => {
    expect(await echoMessage({ chatId: CHAT_ID, message: plainTextMessage("原样"), mode: undefined })).toBe("原样");
    expect(sendMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: "原样" });
    expect(copyMessage).not.toHaveBeenCalled();
  });

  test("图注照样变换，媒体复制并换成新图注", async () => {
    await echoMessage({ chatId: CHAT_ID, message: mediaMessage("你好"), mode: "reverse" });
    expect(copyMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 5, caption: "好你" }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("付费媒体只发文字；投票这类没有文字也没有文件的消息原样复制", async () => {
    await echoMessage({
      chatId: CHAT_ID,
      message: { message_id: 8, date: 1, chat: { id: CHAT_ID, type: "supergroup" }, paid_media: { star_count: 1, paid_media: [] }, caption: "付费" } as unknown as Message,
      mode: "nya",
    });
    expect(sendMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: "付费 喵~" });
    expect(copyMessage).not.toHaveBeenCalled();

    await echoMessage({
      chatId: CHAT_ID,
      message: { message_id: 9, date: 1, chat: { id: CHAT_ID, type: "supergroup" }, poll: { id: "p", question: "?" } } as unknown as Message,
      mode: "nya",
    });
    expect(copyMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 9, caption: undefined }));
  });

  test("变换后超过正文或图注上限时整条丢弃", async () => {
    expect(await echoMessage({ chatId: CHAT_ID, message: plainTextMessage("x".repeat(4094)), mode: "nya" })).toBeUndefined();
    expect(await echoMessage({ chatId: CHAT_ID, message: mediaMessage("x".repeat(1022)), mode: "nya" })).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(copyMessage).not.toHaveBeenCalled();
  });
});
