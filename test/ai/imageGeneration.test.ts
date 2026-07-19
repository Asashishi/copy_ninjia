import { beforeEach, describe, expect, mock, test } from "bun:test";

const requestGeminiResponse = mock(async (..._args: unknown[]): Promise<unknown> => null);

mock.module("../../src/ai/gemini", () => ({ requestGeminiResponse }));

const { generateChatImage, normalizeImageAspectRatio } = await import("../../src/ai/imageGeneration");
const {
  GEMINI_IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_ASPECT_RATIOS,
} = await import("../../src/consts/aiChat/imageGeneration");

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
    const expectedBytes: Buffer = Buffer.from("final-image");
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{
        content: {
          parts: [
            { text: "draft" },
            { thought: true, inlineData: { mimeType: "image/png", data: Buffer.from("thought").toString("base64") } },
            { inlineData: { mimeType: "image/png", data: expectedBytes.toString("base64") } },
          ],
        },
      }],
    });

    const image = await generateChatImage("一只纸飞机", "16:9");

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

  test("没有可用 PNG/JPEG 时返回 null", async () => {
    requestGeminiResponse.mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/webp", data: "AAAA" } }] } }],
    });

    await expect(generateChatImage("test", "1:1")).resolves.toBeNull();
  });
});
