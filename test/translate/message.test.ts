import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "grammy/types";
import type { TranslateLanguage, TranslateState } from "../../packages/types/translate";
import { translateStates } from "../../packages/cache/main/translateState";

const copyMessage = mock(async (..._args: unknown[]): Promise<number> => 10);
const sendMessage = mock(async (..._args: unknown[]): Promise<number> => 11);
const translateText = mock(async (..._args: unknown[]): Promise<string | null> => "translated");
let enabled: boolean = true;
let configured: boolean = true;
mock.module("../../packages/infra/telegram", () => ({ copyMessage, sendMessage }));
mock.module("../../packages/translate/client", () => ({ translateText }));
mock.module("../../packages/config/readiness", () => ({ translateConfigReadiness: () => ({ ok: configured }) }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: () => ({ isTranslationEnabled: enabled }),
  activeCopyTargetIdIn: () => 999,
  persistGlobalState: async (): Promise<void> => {},
}));
const { activeTranslateStateIn, translateMessage } = await import("../../packages/translate/message");
const { stopTranslation, setTranslateState } = await import("../../packages/translate/state");

function params(text: string, language: TranslateLanguage = "ja"): {
  chatId: number;
  message: Message;
  state: TranslateState;
  messageThreadId: number;
} {
  const state: TranslateState = { translatedUser: { id: 7 }, language };
  translateStates.set(-1001, [state]);
  return {
    chatId: -1001,
    message: {
      message_id: 5,
      date: 1,
      chat: { id: -1001, type: "supergroup", title: "Test" },
      from: { id: 7, is_bot: false, first_name: "Target" },
      text,
    },
    state,
    messageThreadId: 42,
  };
}

beforeEach(() => {
  translateStates.clear();
  enabled = true;
  configured = true;
  copyMessage.mockClear();
  sendMessage.mockClear();
  translateText.mockReset();
  translateText.mockResolvedValue("translated");
});

describe("独立翻译消息", () => {
  test.each(["add", "stop-other", "stop-self"])("在途翻译遇到 %s 时按目标独立取消", async (change: string) => {
    const pending = Promise.withResolvers<string | null>();
    translateText.mockImplementationOnce(() => pending.promise);
    const input = params("你好", "uk");
    setTranslateState(-1001, { translatedUser: { id: 8 }, language: "ru" });
    const task: Promise<void> = translateMessage(input);
    if (change === "add") setTranslateState(-1001, { translatedUser: { id: 9 }, language: "en" });
    else await stopTranslation(-1001, change === "stop-self" ? 7 : 8);
    pending.resolve("Привіт");
    await task;
    expect(sendMessage).toHaveBeenCalledTimes(change === "stop-self" ? 0 : 1);
  });

  test.each([
    ["こんにちは", "ja"], ["你好", "cn"], ["这是一条中文消息", "cn"], ["Hello!", "en"], ["123🙂", "ja"],
    ["Привіт, світе!", "uk"], ["Привет, мир!", "ru"], ["123🙂", "uk"], ["123🙂", "ru"],
  ] as const)("同语种或中性内容 %s 复用普通复制，不请求 API", async (text: string, language: TranslateLanguage) => {
    await translateMessage(params(text, language));
    expect(translateText).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(copyMessage).toHaveBeenCalledWith({
      chatId: -1001, fromChatId: -1001, messageId: 5, messageThreadId: 42,
    });
  });

  test.each(["ja", "cn", "en"] as const)("跨语种发送 %s 翻译，保留话题且不挂回复", async (language: TranslateLanguage) => {
    await translateMessage(params("Привет", language));
    expect(translateText).toHaveBeenCalledWith("Привет", language);
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ chatId: -1001, text: "translated", messageThreadId: 42 });
  });

  test.each([
    ["你好", "uk"], ["你好", "ru"], ["Привіт, світе!", "ru"], ["Ёжик съел сыр", "uk"],
  ] as const)("%s 翻成 %s 时请求 API 并保留话题", async (text: string, language: TranslateLanguage) => {
    await translateMessage(params(text, language));
    expect(translateText).toHaveBeenCalledWith(text, language);
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ chatId: -1001, text: "translated", messageThreadId: 42 });
  });

  test("带格式实体的文字复用普通复制，不破坏偏移", async () => {
    const formatted = params("你好");
    formatted.message = { ...formatted.message, entities: [{ type: "bold", offset: 0, length: 2 }] } as Message;
    await translateMessage(formatted);
    expect(translateText).not.toHaveBeenCalled();
    expect(copyMessage).toHaveBeenCalledTimes(1);
  });

  test.each([
    { photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }], caption: "你好" },
    { sticker: { file_id: "f", file_unique_id: "u", type: "regular", width: 1, height: 1, is_animated: false, is_video: false } },
    { video: { file_id: "f", file_unique_id: "u", width: 1, height: 1, duration: 1 }, caption: "你好" },
    { animation: { file_id: "f", file_unique_id: "u", width: 1, height: 1, duration: 1 }, caption: "你好" },
    { document: { file_id: "f", file_unique_id: "u" }, caption: "你好", caption_entities: [{ type: "bold", offset: 0, length: 2 }] },
    { voice: { file_id: "f", file_unique_id: "u", duration: 1 }, caption: "你好" },
    { audio: { file_id: "f", file_unique_id: "u", duration: 1 }, caption: "你好" },
    { video_note: { file_id: "f", file_unique_id: "u", duration: 1, length: 1 } },
    { location: { longitude: 0, latitude: 0 } },
    { contact: { phone_number: "123", first_name: "Target" } },
  ])("非文字消息 %j 不复制、不翻译、不发送", async (media: object) => {
    const input = params("你好");
    const { text: _text, ...message } = input.message;
    input.message = { ...message, ...media } as Message;
    await translateMessage(input);
    expect(translateText).not.toHaveBeenCalled();
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("原文、图注与翻译输出的可渲染命令均被拒绝", async () => {
    await translateMessage(params("test /block 123"));
    const media = params("你好");
    media.message = { message_id: 5, date: 1, chat: media.message.chat, caption: "/block 123" } as Message;
    await translateMessage(media);
    expect(translateText).not.toHaveBeenCalled();
    translateText.mockResolvedValueOnce("result /block 123");
    await translateMessage(params("你好"));
    expect(copyMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("API 失败复制原文", async () => {
    translateText.mockResolvedValueOnce(null);
    await translateMessage(params("你好"));
    expect(copyMessage).toHaveBeenCalledTimes(1);
  });

  test("繁体转简体仍请求翻译，不按中文同语种复制", async () => {
    await translateMessage(params("這是一條中文訊息", "cn"));
    expect(translateText).toHaveBeenCalledWith("這是一條中文訊息", "cn");
    expect(copyMessage).not.toHaveBeenCalled();
  });

  test.each(["stop", "replace", "disable", "config"])("在途请求遇到 %s 后不得迟到发送", async (change: string) => {
    const pending = Promise.withResolvers<string | null>();
    translateText.mockImplementationOnce(() => pending.promise);
    const input = params("你好");
    const task = translateMessage(input);
    if (change === "stop") await stopTranslation(-1001);
    if (change === "replace") translateStates.set(-1001, [{ ...input.state }]);
    if (change === "disable") enabled = false;
    if (change === "config") configured = false;
    pending.resolve("こんにちは");
    await task;
    expect(sendMessage).not.toHaveBeenCalled();
    expect(copyMessage).not.toHaveBeenCalled();
  });

  test("缺省开关或配置不可用不触发翻译，空会话不暴露目标", async () => {
    expect(activeTranslateStateIn(-1001, 7)).toBeUndefined();
    const input = params("你好");
    enabled = false;
    await translateMessage(input);
    enabled = true;
    configured = false;
    await translateMessage(input);
    expect(translateText).not.toHaveBeenCalled();
    expect(copyMessage).not.toHaveBeenCalled();
  });
});
