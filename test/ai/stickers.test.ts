import { describe, expect, mock, test } from "bun:test";

/**
 * ai/stickers.ts 经 infra/telegram -> infra/logger -> infra/diskIO，后者在
 * 模块顶层就会 `new Worker(...)`：单测里绝不能让它真的跑起来（理由同
 * test/commands/luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 * 它还会经 ai/stickerCatalog.ts 间接 import ai/xai.ts -> infra/config，但
 * 只在函数调用时才真正发请求，模块加载本身不会触网。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { parseStickerSelectionIndex } = await import("../../src/ai/stickers");

describe("ai/stickers parseStickerSelectionIndex", () => {
  test("合法编号原样解析", () => {
    expect(parseStickerSelectionIndex("3", 5)).toBe(3);
    expect(parseStickerSelectionIndex("1", 1)).toBe(1);
  });

  test("容忍多余空白/标点，取第一段数字", () => {
    expect(parseStickerSelectionIndex("  2\n", 5)).toBe(2);
    expect(parseStickerSelectionIndex("**4**", 5)).toBe(4);
    expect(parseStickerSelectionIndex("编号：2", 5)).toBe(2);
  });

  test("NONE 或空输出解析不出数字，返回 null", () => {
    expect(parseStickerSelectionIndex("NONE", 5)).toBeNull();
    expect(parseStickerSelectionIndex("", 5)).toBeNull();
    expect(parseStickerSelectionIndex("   ", 5)).toBeNull();
  });

  test("越界编号（0、超出候选数）返回 null", () => {
    expect(parseStickerSelectionIndex("0", 5)).toBeNull();
    expect(parseStickerSelectionIndex("6", 5)).toBeNull();
    // 正则只提取数字段，不认负号——"-99" 里提取到的 "99" 依然越界，间接
    // 覆盖了「输出带负号」这类偏离指令的情形。
    expect(parseStickerSelectionIndex("-99", 5)).toBeNull();
  });

  test("候选数为 0 时任何编号都越界", () => {
    expect(parseStickerSelectionIndex("1", 0)).toBeNull();
  });
});
