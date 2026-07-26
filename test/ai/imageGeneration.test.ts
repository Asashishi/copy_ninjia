import { beforeEach, describe, expect, mock, test } from "bun:test";

const requestGeminiResponse = mock(async (..._args: unknown[]): Promise<unknown> => null);

mock.module("../../packages/ai/gemini", () => ({ requestGeminiResponse }));

const { generateChatImage, normalizeImageAspectRatio } = await import("../../packages/ai/imageGeneration");
const {
  GEMINI_IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MAX_BYTES,
} = await import("../../packages/consts/aiChat/imageGeneration");

beforeEach(() => {
  requestGeminiResponse.mockClear();
  requestGeminiResponse.mockResolvedValue(null);
});

describe("图片比例归一化", () => {
  test("官方比例原样保留，省略时使用 1:1", () => {
    for (const ratio of IMAGE_GENERATION_ASPECT_RATIOS) {
      expect(normalizeImageAspectRatio(ratio)).toBe(ratio);
    }
    expect(normalizeImageAspectRatio(undefined)).toBe("1:1");
    expect(normalizeImageAspectRatio("   ")).toBe("1:1");
  });

  test("接受常见比例写法，并把非官方比例换成最接近的官方比例", () => {
    expect(normalizeImageAspectRatio("7:5")).toBe("4:3");
    expect(normalizeImageAspectRatio("10/7")).toBe("3:2");
    expect(normalizeImageAspectRatio("1920x1080")).toBe("16:9");
    expect(normalizeImageAspectRatio("1200×1500")).toBe("4:5");
  });

  test("拒绝缺边、非数字与非正数比例", () => {
    expect(normalizeImageAspectRatio("16")).toBeNull();
    expect(normalizeImageAspectRatio("wide:tall")).toBeNull();
    expect(normalizeImageAspectRatio("0:1")).toBeNull();
    expect(normalizeImageAspectRatio("-1:1")).toBeNull();
  });
});

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

    const image = await generateChatImage({ prompt: "一只纸飞机", aspectRatio: "16:9" });

    expect(requestGeminiResponse).toHaveBeenCalledWith({
      model: GEMINI_IMAGE_GENERATION_MODEL,
      contents: "一只纸飞机",
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "16:9", imageSize: "1K" },
      },
    }, "Gemini image generation API");
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

    await generateChatImage({
      prompt: "把原图改成水彩",
      aspectRatio: "4:3",
      referenceImage: { bytes: referenceBytes, mime: "image/jpeg" },
    });

    expect(requestGeminiResponse).toHaveBeenCalledWith({
      model: GEMINI_IMAGE_GENERATION_MODEL,
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
    }, "Gemini image generation API");
  });

  test("没有可用 PNG/JPEG 时返回 null", async () => {
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/webp", data: "AAAA" } }] } }],
    });

    await expect(generateChatImage({ prompt: "test", aspectRatio: "1:1" })).resolves.toBeNull();
  });

  test("异常结束原因即使夹带图片 payload 也不会返回", async () => {
    const encoded: string = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");
    for (const finishReason of ["MAX_TOKENS", "SAFETY", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "NO_IMAGE"]) {
      requestGeminiResponse.mockResolvedValueOnce({
        candidates: [{ finishReason, content: { parts: [{ inlineData: { mimeType: "image/png", data: encoded } }] } }],
      });
      await expect(generateChatImage({ prompt: "test", aspectRatio: "1:1" })).resolves.toBeNull();
    }
  });

  test("拒绝非法 base64 与 MIME/文件签名不一致的数据", async () => {
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: "not-base64!" } }] },
      }],
    });
    await expect(generateChatImage({ prompt: "bad base64", aspectRatio: "1:1" })).resolves.toBeNull();

    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64") } }] },
      }],
    });
    await expect(generateChatImage({ prompt: "wrong signature", aspectRatio: "1:1" })).resolves.toBeNull();
  });

  test("编码长度已证明解码后可能超限时不分配图片 Buffer", async () => {
    const encodedOverLimit: string = "A".repeat(Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4 + 4);
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "image/png", data: encodedOverLimit } }] },
      }],
    });

    await expect(generateChatImage({ prompt: "oversized", aspectRatio: "1:1" })).resolves.toBeNull();
  });
});
