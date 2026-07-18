import { describe, expect, test } from "bun:test";
import { parseReactionConfig, parseStickerConfig, parseTelegramUserId, parseTelegramUserIdList } from "../../src/libs/runtimeConfig";

describe("runtime config validation", () => {
  test("accepts valid sticker and reaction configs", () => {
    expect(parseStickerConfig({ packs: ["pack_one", "Pack2"] })).toEqual({ packs: ["pack_one", "Pack2"] });
    expect(parseReactionConfig({ emotionKeywords: { "👍": ["赞"] } })).toEqual({ emotionKeywords: { "👍": ["赞"] } });
  });

  test("rejects duplicate, malformed and unknown sticker config values", () => {
    expect(() => parseStickerConfig({ packs: ["same", "same"] })).toThrow("Duplicate");
    expect(() => parseStickerConfig({ packs: ["https://t.me/addstickers/x"] })).toThrow("pack name");
    expect(() => parseStickerConfig({ packs: [], extra: true })).toThrow("expected exactly");
  });

  test("rejects malformed reaction config values", () => {
    expect(() => parseReactionConfig({ emotionKeywords: { "": ["x"] } })).toThrow("entry");
    expect(() => parseReactionConfig({ emotionKeywords: { "👍": [1] } })).toThrow("entry");
    expect(() => parseReactionConfig({ emotionKeywords: {}, extra: true })).toThrow("expected exactly");
  });

  test("only accepts positive decimal safe Telegram user IDs", () => {
    expect(parseTelegramUserId("123", "TEST")).toBe(123);
    for (const raw of ["0", "-1", "1.5", "1e3", " 1", "9007199254740992"]) {
      expect(() => parseTelegramUserId(raw, "TEST")).toThrow("Invalid Telegram user ID");
    }
  });

  test("accepts an empty privileged list, deduplicates IDs and rejects empty segments", () => {
    expect(parseTelegramUserIdList("", "TEST")).toEqual([]);
    expect(parseTelegramUserIdList("1, 2,1", "TEST")).toEqual([1, 2]);
    expect(() => parseTelegramUserIdList("1,,2", "TEST")).toThrow("Invalid Telegram user ID");
  });
});
