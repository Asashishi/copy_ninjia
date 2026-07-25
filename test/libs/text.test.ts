import { describe, expect, test } from "bun:test";
import { splitGraphemes, truncateAtClauseBoundary, truncateInline } from "../../packages/libs/text";

describe("libs/text truncateAtClauseBoundary", () => {
  test("不超限时原样返回", () => {
    expect(truncateAtClauseBoundary("一句话。", 20)).toBe("一句话。");
  });

  test("超限时收在最后一个句末标点（含标点），不把句子剁在半截", () => {
    // 硬切点落在第二句中间：应回收到第一句句号为止。
    expect(truncateAtClauseBoundary("第一句说完了。第二句还没说完就要被截断了", 15)).toBe("第一句说完了。");
  });

  test("切点内没有句末标点时退而收在子句分隔符之前（丢掉悬空的逗号）", () => {
    expect(truncateAtClauseBoundary("前半句讲了一件事情，后半句还在继续讲呢", 15)).toBe("前半句讲了一件事情");
  });

  test("边界过于靠前（收完不足上限一半）时放弃找边界，退回硬切", () => {
    const text: string = "短。" + "很长的一段没有任何标点的内容一直延续下去".repeat(3);
    expect(truncateAtClauseBoundary(text, 20)).toBe(truncateInline(text, 20));
  });

  test("整段没有任何标点时退回硬切", () => {
    const text: string = "完全没有标点的一大段描述文本一直写一直写一直写";
    expect(truncateAtClauseBoundary(text, 10)).toBe(truncateInline(text, 10));
  });

  test("回归：maxChars=1（minKeep=0）时不因 -1 哨兵值巧合满足边界判断而丢光硬切内容", () => {
    const text: string = "无标点内容";
    expect(truncateAtClauseBoundary(text, 1)).toBe(truncateInline(text, 1));
    expect(truncateAtClauseBoundary(text, 1)).not.toBe("");
  });
});

describe("libs/text splitGraphemes", () => {
  test("ZWJ 表情和组合附加符分别保持为一个字形簇", () => {
    expect(splitGraphemes("A👨‍👩‍👧‍👦éB")).toEqual(["A", "👨‍👩‍👧‍👦", "é", "B"]);
  });
});
