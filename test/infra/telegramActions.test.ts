import { afterEach, describe, expect, mock, test } from "bun:test";
import { InputFile, type Api } from "grammy";
import { sentMessages } from "../../src/cache/selfSentTracker";
import {
  isChatMember,
  sendMessageWithResult,
  sendPhotoWithResult,
} from "../../src/infra/telegram/actions";
import { isSelfSent } from "../../src/infra/selfSentTracker";

afterEach(() => {
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
});

describe("Telegram 常规动作封装", () => {
  test("发送文字时返回服务端实际建立的回复关系，并登记自发消息", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({
      message_id: 77,
      reply_to_message: { message_id: 42 },
    }));
    const api = { sendMessage: sendMessageMock } as unknown as Api;

    const sent = await sendMessageWithResult({
      chatId: -1001,
      text: "hello",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 77, repliedToMessageId: 42 });
    expect(sendMessageMock).toHaveBeenCalledWith(-1001, "hello", {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(isSelfSent(-1001, 77)).toBe(true);
  });

  test("回复目标已删除时仍发送文字，但结果不伪造回复关系", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({ message_id: 79 }));
    const api = { sendMessage: sendMessageMock } as unknown as Api;

    const sent = await sendMessageWithResult({
      chatId: -1001,
      text: "hello",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 79 });
    expect(isSelfSent(-1001, 79)).toBe(true);
  });

  test("从内存上传生成图片，并返回服务端实际建立的回复关系", async () => {
    const sendPhotoMock = mock(async (..._args: unknown[]) => ({
      message_id: 78,
      reply_to_message: { message_id: 42 },
    }));
    const api = { sendPhoto: sendPhotoMock } as unknown as Api;

    const sent = await sendPhotoWithResult({
      chatId: -1001,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      replyToMessageId: 42,
      api,
    });

    expect(sent).toEqual({ messageId: 78, repliedToMessageId: 42 });
    expect(sendPhotoMock).toHaveBeenCalledWith(-1001, expect.any(InputFile), {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(isSelfSent(-1001, 78)).toBe(true);
  });

  test("正确区分当前成员、受限成员和已离开成员", async () => {
    const apiFor = (member: unknown): Api =>
      ({ getChatMember: mock(async (..._args: unknown[]) => member) }) as unknown as Api;

    expect(await isChatMember(-1001, 1, apiFor({ status: "member" }))).toBe(true);
    expect(await isChatMember(-1001, 2, apiFor({ status: "administrator" }))).toBe(true);
    expect(await isChatMember(-1001, 3, apiFor({ status: "restricted", is_member: true }))).toBe(true);
    expect(await isChatMember(-1001, 4, apiFor({ status: "restricted", is_member: false }))).toBe(false);
    expect(await isChatMember(-1001, 5, apiFor({ status: "left" }))).toBe(false);
  });
});
