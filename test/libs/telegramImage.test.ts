import { describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { isSendablePhotoDimensions, messageImageCandidate } from "../../packages/libs/telegramImage";
import { TELEGRAM_PHOTO_MAX_ASPECT_RATIO, TELEGRAM_PHOTO_MAX_DIMENSION_SUM } from "../../packages/consts/telegram";

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

describe("isSendablePhotoDimensions", () => {
  test("宽高之和的边界：恰好 10000 放行，多 1 像素就拒", () => {
    // w + h = 10000 且长宽比仍在 20 以内的最扁一档。
    expect(isSendablePhotoDimensions({ width: 9_523, height: 477 })).toBeTrue();
    expect(9_523 + 477).toBe(TELEGRAM_PHOTO_MAX_DIMENSION_SUM);
    expect(isSendablePhotoDimensions({ width: 9_524, height: 477 })).toBeFalse();
    expect(isSendablePhotoDimensions({ width: 5_000, height: 5_000 })).toBeTrue();
    expect(isSendablePhotoDimensions({ width: 5_001, height: 5_000 })).toBeFalse();
  });

  test("长宽比的边界：恰好 20 放行，超一点就拒；两个方向同判", () => {
    expect(isSendablePhotoDimensions({ width: 2_000, height: 100 })).toBeTrue();
    expect(2_000 / 100).toBe(TELEGRAM_PHOTO_MAX_ASPECT_RATIO);
    expect(isSendablePhotoDimensions({ width: 100, height: 2_000 })).toBeTrue();
    expect(isSendablePhotoDimensions({ width: 2_001, height: 100 })).toBeFalse();
    expect(isSendablePhotoDimensions({ width: 100, height: 2_001 })).toBeFalse();
  });

  test("字节小但发不出去的长条图：两道门槛互不蕴含", () => {
    // 12000×40 的 PNG 只有几十 KB，字节闸放行，sendPhoto 仍以
    // PHOTO_INVALID_DIMENSIONS 拒绝。
    expect(isSendablePhotoDimensions({ width: 12_000, height: 40 })).toBeFalse();
  });

  test("零或负的边长按不合规处理", () => {
    for (const dimensions of [{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: -1, height: 10 }]) {
      expect(isSendablePhotoDimensions(dimensions)).toBeFalse();
    }
  });

  test("寻常尺寸照常放行", () => {
    expect(isSendablePhotoDimensions({ width: 1_280, height: 1_280 })).toBeTrue();
    expect(isSendablePhotoDimensions({ width: 1, height: 1 })).toBeTrue();
  });
});
