import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@grammyjs/types";

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
  getActiveCopyIn: (): null => null,
}));
mock.module("../../packages/copy/availability", () => ({
  isJaTranslationActiveIn: (): boolean => false,
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

    expect(copyMessage).toHaveBeenCalledWith(CHAT_ID, CHAT_ID, 5);
  });

  test("没有 caption 的媒体消息照常复读", async () => {
    await echoMessage({
      chatId: CHAT_ID,
      message: mediaMessage(undefined),
      mode: undefined,
    });

    expect(copyMessage).toHaveBeenCalledWith(CHAT_ID, CHAT_ID, 5);
  });

  test("命令不在行首的 caption 同样不复读", async () => {
    // 这道闸曾经只判 startsWith("/")：命令挪到中段就整条绕过去，而带
    // bot_command 实体的消息拿不到 plainText，会直接落到 copyMessage 被原样
    // 重发——变换后那道守卫根本轮不到，等于两条兄弟分支各判各的。
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

    expect(copyMessage).toHaveBeenCalledWith(CHAT_ID, CHAT_ID, 5);
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

/** 纯文本（无 entity）才会走文本变换分支。 */
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
