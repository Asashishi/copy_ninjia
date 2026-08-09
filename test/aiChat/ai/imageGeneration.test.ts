/**
 * 生图领域入口的供应商中立行为：宽高比归一与「入口只做转发」。
 * 两家实现包各自的请求映射与载荷提取见 test/aiChat/{gemini,openai}/image.test.ts。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const generateImage = mock(async (..._args: unknown[]): Promise<unknown> => null);

// 生图入口只取 imageAiProvider()，不受 text/summary/media 的路由影响。
mock.module("../../../packages/aiChat/provider", () => ({
  imageAiProvider: () => ({ name: "test", generateImage }),
}));

const { generateChatImage } = await import("../../../packages/aiChat/ai/imageGeneration");
const { normalizeImageAspectRatio } = await import("../../../packages/aiChat/ai/utils/aspectRatio");
const { IMAGE_GENERATION_ASPECT_RATIOS } = await import("../../../packages/consts/aiChat/imageGeneration");

beforeEach(() => {
  generateImage.mockClear();
  generateImage.mockResolvedValue(null);
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

describe("生图领域入口", () => {
  test("原样转发给当前供应商，不在入口层改写任何字段", async () => {
    const referenceImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: "image/jpeg" as const };
    const signal: AbortSignal = new AbortController().signal;
    await generateChatImage({ prompt: "一只纸飞机", aspectRatio: "16:9", referenceImage, signal });

    expect(generateImage).toHaveBeenCalledWith({
      prompt: "一只纸飞机",
      aspectRatio: "16:9",
      referenceImage,
      signal,
    });
  });

  test("供应商无可用载荷时原样返回 null", async () => {
    await expect(generateChatImage({ prompt: "test", aspectRatio: "1:1" })).resolves.toBeNull();
  });
});
