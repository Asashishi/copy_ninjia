import { describe, expect, test } from "bun:test";

const { applyCopyModeTransform, describeCopyModeEffect } = await import("../packages/copy/copyModes");

describe("copy mode 文本变换", () => {
  test("反转按字形簇处理，喵后缀不会重复追加", () => {
    expect(applyCopyModeTransform("A🙂B", "reverse")).toBe("B🙂A");
    expect(applyCopyModeTransform("你好", "nya")).toBe("你好 喵~");
    expect(applyCopyModeTransform("你好 喵~", "nya")).toBe("你好 喵~");
  });

  test("未指定模式时返回 null", () => {
    expect(applyCopyModeTransform("原文", undefined)).toBeNull();
  });

  test("启动提示按模式描述实际效果", () => {
    expect(describeCopyModeEffect("reverse")).toContain("倒过来");
    expect(describeCopyModeEffect("nya")).toContain("喵~");
    expect(describeCopyModeEffect(undefined)).toBe("");
  });
});
