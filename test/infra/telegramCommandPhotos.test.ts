import { beforeEach, describe, expect, mock, test } from "bun:test";
import { InputFile } from "grammy";

const sendPhoto = mock(async (chatId: number, ..._rest: unknown[]): Promise<unknown> => ({ message_id: 55, chat: { id: chatId } }));
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const markSelfSent = mock((_chatId: number, _messageId: number): void => {});
mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api: { sendPhoto } } }));
mock.module("../../packages/infra/telegram/actions/messageLifecycle", () => ({ deleteMessageAfter }));
mock.module("../../packages/infra/selfSentTracker", () => ({ markSelfSent }));

const { sendCommandPhoto } = await import("../../packages/infra/telegram/commandPhotos");
const { COMMAND_MESSAGE_AUTO_DELETE_MS } = await import("../../packages/consts/commands");

beforeEach(() => {
  sendPhoto.mockClear();
  deleteMessageAfter.mockClear();
  markSelfSent.mockClear();
});

describe("sendCommandPhoto", () => {
  test("群聊发送成功即登记自发消息与 30 秒删除；file_id 原样交给 Telegram", async () => {
    const entities = [{ type: "code" as const, offset: 3, length: 2 }];
    expect(await sendCommandPhoto({
      chatId: -1001, photo: "file-id", caption: "ID：42", captionEntities: entities, replyToMessageId: 7, messageThreadId: 3,
    })).toBe(55);
    expect(sendPhoto).toHaveBeenCalledWith(-1001, "file-id", {
      caption: "ID：42",
      caption_entities: entities,
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      message_thread_id: 3,
    });
    expect(markSelfSent).toHaveBeenCalledWith(-1001, 55);
    expect(deleteMessageAfter).toHaveBeenCalledWith({ chatId: -1001, messageId: 55, delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS });
  });

  test("字节按上传文件发送；私聊不挂删除", async () => {
    await sendCommandPhoto({ chatId: 42, photo: new Uint8Array([1, 2]), caption: "x", captionEntities: [] });
    expect(sendPhoto.mock.calls[0]![1]).toBeInstanceOf(InputFile);
    expect((sendPhoto.mock.calls[0]![2] as { caption_entities: unknown }).caption_entities).toBeUndefined();
    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });

  test("发送失败返回 undefined，不创建删除任务", async () => {
    sendPhoto.mockImplementationOnce(async (): Promise<unknown> => { throw new Error("Bad Request: wrong file identifier"); });
    expect(await sendCommandPhoto({ chatId: -1001, photo: "bad", caption: "x", captionEntities: [] })).toBeUndefined();
    expect(deleteMessageAfter).not.toHaveBeenCalled();
    expect(markSelfSent).not.toHaveBeenCalled();
  });
});
