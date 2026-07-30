import { describe, expect, test } from "bun:test";

const { describeStickerForContext, pickStickerVisionSource } = await import("../../../packages/ai/stickers/describe");

describe("ai/stickers/describe describeStickerForContext", () => {
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

describe("ai/stickers/describe pickStickerVisionSource", () => {
  test("静态贴纸直接用本体 file_id，file_unique_id 是贴纸自身的", () => {
    const sticker: any = { file_id: "body-id", file_unique_id: "sticker-uid", width: 512, height: 384, is_animated: false, is_video: false };
    expect(pickStickerVisionSource(sticker)).toEqual({ fileId: "body-id", fileUniqueId: "sticker-uid", width: 512, height: 384 });
  });

  test("视频贴纸没有可解码本体，改用缩略图的 file_id，但 fileUniqueId 仍是贴纸自身的", () => {
    const sticker: any = {
      file_id: "body-id",
      file_unique_id: "sticker-uid",
      is_animated: false,
      is_video: true,
      thumbnail: { file_id: "thumb-id", file_unique_id: "thumb-uid", width: 320, height: 180 },
    };
    expect(pickStickerVisionSource(sticker)).toEqual({ fileId: "thumb-id", fileUniqueId: "sticker-uid", width: 320, height: 180 });
  });

  test("动态（tgs）贴纸同理，走缩略图", () => {
    const sticker: any = {
      file_id: "body-id",
      file_unique_id: "sticker-uid",
      is_animated: true,
      is_video: false,
      thumbnail: { file_id: "thumb-id", file_unique_id: "thumb-uid", width: 256, height: 256 },
    };
    expect(pickStickerVisionSource(sticker)).toEqual({ fileId: "thumb-id", fileUniqueId: "sticker-uid", width: 256, height: 256 });
  });

  test("动态/视频贴纸没有缩略图时放弃视觉解析，返回 null", () => {
    const sticker: any = { file_id: "body-id", file_unique_id: "sticker-uid", is_animated: true, is_video: false };
    expect(pickStickerVisionSource(sticker)).toBeNull();
  });
});
