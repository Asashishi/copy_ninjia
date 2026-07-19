import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Api } from "grammy";
import { sentMessages } from "../../src/cache/selfSentTracker";
import { isChatMember, sendMessage } from "../../src/infra/telegram/actions";
import { isSelfSent } from "../../src/infra/selfSentTracker";

afterEach(() => {
  for (const timer of sentMessages.values()) clearTimeout(timer);
  sentMessages.clear();
});

describe("Telegram 常规动作封装", () => {
  test("发送回复时允许被引用消息已删除，并登记自发消息", async () => {
    const sendMessageMock = mock(async (..._args: unknown[]) => ({ message_id: 77 }));
    const api = { sendMessage: sendMessageMock } as unknown as Api;

    const messageId: number | undefined = await sendMessage({
      chatId: -1001,
      text: "hello",
      replyToMessageId: 42,
      api,
    });

    expect(messageId).toBe(77);
    expect(sendMessageMock).toHaveBeenCalledWith(-1001, "hello", {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(isSelfSent(-1001, 77)).toBe(true);
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
