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

const { describeStickerForContext, matchCandidateEmojis, pickStickerVisionSource } = await import("../../src/ai/stickerSets");

describe("ai/stickerSets matchCandidateEmojis", () => {
  const emotionKeywords = { "😂": ["哈哈", "笑死"], "😭": ["哭", "呜呜"] };

  test("命中一个或多个关键词时返回对应候选 emoji 集合", () => {
    expect(matchCandidateEmojis(emotionKeywords, "笑死我了哈哈")).toEqual(new Set(["😂"]));
    expect(matchCandidateEmojis(emotionKeywords, "哭死了呜呜")).toEqual(new Set(["😭"]));
  });

  test("未命中任何关键词返回空集合", () => {
    expect(matchCandidateEmojis(emotionKeywords, "今天天气不错")).toEqual(new Set());
  });
});

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
