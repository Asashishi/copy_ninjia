import { describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { messageImageCandidate } from "../../packages/libs/telegramImage";

function message(fields: Record<string, unknown>): Message {
  return { message_id: 1, date: 1, chat: { id: -1, type: "supergroup", title: "g" }, ...fields } as unknown as Message;
}

describe("messageImageCandidate", () => {
  test("图片取最大尺寸", () => {
    expect(messageImageCandidate(message({
      photo: [
        { file_id: "small", file_unique_id: "u-small", width: 90, height: 90, file_size: 10 },
        { file_id: "large", file_unique_id: "u-large", width: 1280, height: 1280, file_size: 200 },
      ],
    }))).toEqual({ fileId: "large", fileUniqueId: "u-large", fileSize: 200 });
  });

  test("以文件发送的图片只收 jpeg、png、webp", () => {
    expect(messageImageCandidate(message({ document: { file_id: "d", file_unique_id: "u-d", mime_type: "image/png" } })))
      .toEqual({ fileId: "d", fileUniqueId: "u-d", fileSize: undefined });
    for (const mime of ["image/gif", "application/pdf", undefined]) {
      expect(messageImageCandidate(message({ document: { file_id: "d", file_unique_id: "u-d", mime_type: mime } }))).toBeUndefined();
    }
  });

  test("文字、贴纸与空图片数组都不是候选", () => {
    expect(messageImageCandidate(message({ text: "hi" }))).toBeUndefined();
    expect(messageImageCandidate(message({ sticker: { file_id: "s", file_unique_id: "u-s" } }))).toBeUndefined();
    expect(messageImageCandidate(message({ photo: [] }))).toBeUndefined();
  });
});
