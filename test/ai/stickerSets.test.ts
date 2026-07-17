import { describe, expect, mock, test } from "bun:test";

/**
 * ai/stickerSets.ts 经 infra/telegram -> infra/logger -> infra/diskIO，后者
 * 在模块顶层就会 `new Worker(...)`：单测里绝不能让它真的跑起来（理由同
 * test/commands/luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { describeStickerForContext, getStickerSet, pickStickerVisionSource } = await import("../../src/ai/stickerSets");
const { failedPacks, stickerSetCache } = await import("../../src/cache/stickerSets");

describe("ai/stickerSets describeStickerForContext", () => {
  test("emoji + 包名都有时按顺序拼接", () => {
    expect(describeStickerForContext({ emoji: "😂", set_name: "test_pack" })).toBe("（发了一枚贴纸：情绪含义 😂，来自贴纸包「test_pack」）");
  });

  test("都缺失时退化为最简形态", () => {
    expect(describeStickerForContext({})).toBe("（发了一枚贴纸）");
  });

  test("带画面描述时排在最前面", () => {
    expect(describeStickerForContext({ emoji: "😂", set_name: "test_pack" }, "一只猫在大笑")).toBe(
      "（发了一枚贴纸：画面：一只猫在大笑，情绪含义 😂，来自贴纸包「test_pack」）"
    );
  });

  test("只有画面描述、没有元数据", () => {
    expect(describeStickerForContext({}, "一只猫在大笑")).toBe("（发了一枚贴纸：画面：一只猫在大笑）");
  });
});

describe("ai/stickerSets pickStickerVisionSource", () => {
  test("静态贴纸直接用本体 file_id，file_unique_id 是贴纸自身的", () => {
    const sticker: any = { file_id: "body-id", file_unique_id: "sticker-uid", is_animated: false, is_video: false };
    expect(pickStickerVisionSource(sticker)).toEqual({ fileId: "body-id", fileUniqueId: "sticker-uid" });
  });

  test("视频贴纸没有可解码本体，改用缩略图的 file_id，但 fileUniqueId 仍是贴纸自身的", () => {
    const sticker: any = {
      file_id: "body-id",
      file_unique_id: "sticker-uid",
      is_animated: false,
      is_video: true,
      thumbnail: { file_id: "thumb-id", file_unique_id: "thumb-uid" },
    };
    expect(pickStickerVisionSource(sticker)).toEqual({ fileId: "thumb-id", fileUniqueId: "sticker-uid" });
  });

  test("动态（tgs）贴纸同理，走缩略图", () => {
    const sticker: any = {
      file_id: "body-id",
      file_unique_id: "sticker-uid",
      is_animated: true,
      is_video: false,
      thumbnail: { file_id: "thumb-id", file_unique_id: "thumb-uid" },
    };
    expect(pickStickerVisionSource(sticker)).toEqual({ fileId: "thumb-id", fileUniqueId: "sticker-uid" });
  });

  test("动态/视频贴纸没有缩略图时放弃视觉解析，返回 null", () => {
    const sticker: any = { file_id: "body-id", file_unique_id: "sticker-uid", is_animated: true, is_video: false };
    expect(pickStickerVisionSource(sticker)).toBeNull();
  });
});

describe("ai/stickerSets getStickerSet 失败恢复", () => {
  test("瞬时失败只在负缓存窗口内拦截，过期后同一进程会重新请求并恢复", async () => {
    const pack = "retryable_pack";
    const expected: any = { name: pack, title: "Retryable", sticker_type: "regular", stickers: [] };
    let calls = 0;
    const api = {
      getStickerSet: mock(async (): Promise<any> => {
        calls++;
        if (calls === 1) throw new Error("temporary network failure");
        return expected;
      }),
    };

    try {
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(calls).toBe(1);
      expect(failedPacks.get(pack)).toBeGreaterThan(Date.now());

      // 负缓存仍有效时不重复轰 Telegram。
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(calls).toBe(1);

      // 模拟窗口到期：无需重启进程即可重新请求并转为正缓存。
      failedPacks.set(pack, Date.now() - 1);
      expect(await getStickerSet(pack, api)).toBe(expected);
      expect(calls).toBe(2);
      expect(failedPacks.has(pack)).toBe(false);
      expect(stickerSetCache.get(pack)).toBe(expected);
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
    }
  });
});
