import { beforeEach, describe, expect, mock, test } from "bun:test";

const translateToJapanese = mock(async (text: string): Promise<string> => `日语:${text}`);
mock.module("../packages/copy/translate", () => ({ translateToJapanese }));

const { applyCopyModeTransform, describeCopyModeEffect } = await import("../packages/copy/copyModes");

beforeEach(() => {
  translateToJapanese.mockClear();
});

describe("copy mode 文本变换", () => {
  test("反转按字形簇处理，喵后缀不会重复追加", async () => {
    await expect(applyCopyModeTransform("A🙂B", "reverse")).resolves.toBe("B🙂A");
    await expect(applyCopyModeTransform("你好", "nya")).resolves.toBe("你好 喵~");
    await expect(applyCopyModeTransform("你好 喵~", "nya")).resolves.toBe("你好 喵~");
  });

  test("日语模式委托翻译器，未指定模式时返回 null", async () => {
    await expect(applyCopyModeTransform("早上好", "ja")).resolves.toBe("日语:早上好");
    expect(translateToJapanese).toHaveBeenCalledWith("早上好");
    await expect(applyCopyModeTransform("原文", undefined)).resolves.toBeNull();
  });

  test("启动提示按模式描述实际效果", () => {
    expect(describeCopyModeEffect("reverse")).toContain("倒过来");
    expect(describeCopyModeEffect("nya")).toContain("喵~");
    expect(describeCopyModeEffect("ja")).toContain("日语");
    expect(describeCopyModeEffect(undefined)).toBe("");
  });
});
