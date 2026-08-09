import { describe, expect, test } from "bun:test";
import type { AiRecordMediaMessage } from "../../../packages/types/aiChat/protocol";
import {
  composeMediaText,
  fallbackTextFor,
  pendingPlaceholderFor,
  replyFallbackDescriptionFor,
  resolvedTagFor,
} from "../../../packages/workers/aiChat/mediaText";

const stickerMessage: AiRecordMediaMessage = {
  type: "recordMedia",
  kind: "sticker",
  chatId: -1001,
  senderId: 7,
  firstName: "Alice",
  lastName: "",
  caption: "",
  fileId: "file",
  fileUniqueId: "unique",
  width: 512,
  height: 512,
  messageId: 10,
  commentOnResolve: false,
  imageGenerationRequested: false,
  stickerFallbackText: "[贴纸：🙂，来自 pack]",
  voiceMime: undefined,
  voiceDurationSeconds: 0,
  directTrigger: undefined,
  username: undefined,
  replyTo: undefined,
  forwardedFrom: undefined,
  persistImmediately: false,
};

describe("AI 媒体转录文本", () => {
  test("按媒体类型生成待解析、成功和失败标签", () => {
    expect(pendingPlaceholderFor("sticker")).toBe("[贴纸：识别中]");
    expect(pendingPlaceholderFor("animation")).toBe("[GIF：识别中]");
    expect(pendingPlaceholderFor("photo")).toBe("[图片：识别中]");
    expect(resolvedTagFor("sticker", "挥手")).toBe("[贴纸：挥手]");
    expect(resolvedTagFor("animation", "旋转")).toBe("[GIF：旋转]");
    expect(resolvedTagFor("photo", "天空")).toBe("[图片：天空]");
    expect(fallbackTextFor("sticker", stickerMessage)).toBe("[贴纸：🙂，来自 pack]");
    // 没有元数据兜底行的贴纸退回贴纸措辞的占位，不能错标成图片。
    expect(fallbackTextFor("sticker", { ...stickerMessage, stickerFallbackText: undefined })).toBe("[贴纸：解析失败，请无视此消息]");
    expect(fallbackTextFor("animation", { ...stickerMessage, kind: "animation" })).toContain("GIF");
    expect(fallbackTextFor("photo", { ...stickerMessage, kind: "photo" })).toContain("图片");
  });

  test("语音有自己的一套措辞，绝不能落到图片那条 default 分支上", () => {
    expect(pendingPlaceholderFor("voice")).toBe("[语音：识别中]");
    expect(resolvedTagFor("voice", "今天下班一起吃饭吗")).toBe("[语音：今天下班一起吃饭吗]");
    // 贴纸的元数据兜底不适用于语音：这里必须是语音自己的失败占位。
    expect(fallbackTextFor("voice", { ...stickerMessage, kind: "voice", stickerFallbackText: undefined }))
      .toBe("[语音：没听清，请无视此消息]");
  });

  test("caption 只在非空时拼接，直接触发失败时使用可回应描述", () => {
    expect(composeMediaText("[图片：天空]", "晚霞")).toBe("[图片：天空] 晚霞");
    expect(composeMediaText("[图片：天空]", "")).toBe("[图片：天空]");
    expect(replyFallbackDescriptionFor(stickerMessage)).toBe("[贴纸：🙂，来自 pack]");
    expect(replyFallbackDescriptionFor({ ...stickerMessage, kind: "photo" })).toContain("没看清");
    // 必回指令里不能出现「请无视此消息」，否则模型可能听话地沉默；语音这条
    // 说的是「没听清」而不是「没看清」。
    const voiceFallback: string = replyFallbackDescriptionFor({ ...stickerMessage, kind: "voice" });
    expect(voiceFallback).toContain("没听清");
    expect(voiceFallback).not.toContain("请无视");
  });
});
