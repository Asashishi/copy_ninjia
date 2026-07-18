import { describe, expect, test } from "bun:test";
import { loadStickerConfig, parseStickerConfig } from "../../src/config/stickers";

describe("sticker config", () => {
  test("严格解析合法白名单，并能加载部署文件", () => {
    expect(parseStickerConfig({ packs: ["pack_one", "Pack2"] })).toEqual({
      packs: ["pack_one", "Pack2"],
    });
    expect(loadStickerConfig().packs.length).toBeGreaterThan(0);
  });

  test("拒绝重复、非法 short name 和额外字段", () => {
    expect(() => parseStickerConfig({ packs: ["same", "same"] })).toThrow("Duplicate");
    expect(() => parseStickerConfig({ packs: ["https://t.me/addstickers/x"] })).toThrow("pack name");
    expect(() => parseStickerConfig({ packs: [], extra: true })).toThrow("expected exactly");
  });
});
