/**
 * Gemini 生图适配器：请求映射（1K + 宽高比 + 参考图多模态输入）与响应载荷
 * 提取的安全门禁（异常收尾、思考中间图、非法 base64、签名不符、超限）。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GenerateContentParameters } from "@google/genai";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";

const requestGeminiResponse = mock(async (..._args: unknown[]): Promise<unknown> => null);

mock.module("../../../packages/aiChat/gemini/client", () => ({ requestGeminiResponse }));

const { generateGeminiImage } = await import("../../../packages/aiChat/gemini/image");
const {
  IMAGE_GENERATION_MAX_BYTES,
} = await import("../../../packages/consts/aiChat/imageGeneration");

beforeEach(() => {
  requestGeminiResponse.mockClear();
  requestGeminiResponse.mockResolvedValue(null);
});

/** 取第一次调用传进去的请求体闭包并求值。 */
function requestBody(): GenerateContentParameters {
  return (requestGeminiResponse.mock.calls[0]![1] as () => GenerateContentParameters)();
}

describe("Gemini 图片生成适配器", () => {
  test("固定请求 1K 图片，并跳过文本段与思考中间图", async () => {
    const expectedBytes: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [
            { text: "draft" },
            { thought: true, inlineData: { mimeType: "image/png", data: Buffer.from("thought").toString("base64") } },
            { inlineData: { mimeType: "image/png", data: expectedBytes.toString("base64") } },
          ],
        },
      }],
    });

    const image = await generateGeminiImage({ prompt: "一只纸飞机", aspectRatio: "16:9" });

    // 请求体是个闭包而不是拼好的对象：模型名要在 client.ts 的 try 内才被读到，
    // 否则 config/agent.json 写坏时异常会绕开那层失败归一化（见 client.ts 头注）。
    expect(requestBody()).toEqual({
      model: getAgentDeploymentConfig().image?.model ?? "",
      contents: "一只纸飞机",
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "16:9", imageSize: "1K" },
      },
    });
    expect(requestGeminiResponse.mock.calls[0]![0]).toBe("image");
    expect(requestGeminiResponse.mock.calls[0]![2]).toBe("Gemini image generation API");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image?.bytes ?? []).equals(expectedBytes)).toBe(true);
  });

  test("有参考图时把文字与图片字节作为同一个多模态输入发送", async () => {
    const expectedBytes: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const referenceBytes: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: expectedBytes.toString("base64") } }] },
      }],
    });

    await generateGeminiImage({
      prompt: "把原图改成水彩",
      aspectRatio: "4:3",
      referenceImage: { bytes: referenceBytes, mime: "image/jpeg" },
    });

    expect(requestBody()).toEqual({
      model: getAgentDeploymentConfig().image?.model ?? "",
      contents: [{
        role: "user",
        parts: [
          { text: "把原图改成水彩" },
          { inlineData: { mimeType: "image/jpeg", data: referenceBytes.toString("base64") } },
        ],
      }],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "4:3", imageSize: "1K" },
      },
    });
  });

  test("没有可用 PNG/JPEG 时返回 null", async () => {
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/webp", data: "AAAA" } }] } }],
    });

    await expect(generateGeminiImage({ prompt: "test", aspectRatio: "1:1" })).resolves.toBeNull();
  });

  test("异常结束原因即使夹带图片 payload 也不会返回", async () => {
    const encoded: string = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");
    for (const finishReason of ["MAX_TOKENS", "SAFETY", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "NO_IMAGE"]) {
      requestGeminiResponse.mockResolvedValueOnce({
        candidates: [{ finishReason, content: { parts: [{ inlineData: { mimeType: "image/png", data: encoded } }] } }],
      });
      await expect(generateGeminiImage({ prompt: "test", aspectRatio: "1:1" })).resolves.toBeNull();
    }
  });

  test("拒绝非法 base64 与 MIME/文件签名不一致的数据", async () => {
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: "not-base64!" } }] },
      }],
    });
    await expect(generateGeminiImage({ prompt: "bad base64", aspectRatio: "1:1" })).resolves.toBeNull();

    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64") } }] },
      }],
    });
    await expect(generateGeminiImage({ prompt: "wrong signature", aspectRatio: "1:1" })).resolves.toBeNull();
  });

  test("编码长度已证明解码后可能超限时不分配图片 Buffer", async () => {
    const encodedOverLimit: string = "A".repeat(Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4 + 4);
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: encodedOverLimit } }] },
      }],
    });

    await expect(generateGeminiImage({ prompt: "oversized", aspectRatio: "1:1" })).resolves.toBeNull();
  });
});
