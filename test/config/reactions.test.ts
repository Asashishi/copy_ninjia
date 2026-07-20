import { describe, expect, test } from "bun:test";
import {
  loadReactionConfig,
  parseReactionConfig,
} from "../../src/config/reactions";
import { TELEGRAM_REACTION_EMOJIS } from "../../src/consts/reactions";

describe("reaction config", () => {
  test("严格解析标准反应，并能加载全部部署配置", () => {
    expect(parseReactionConfig({ emotionKeywords: { "👍": ["赞"] } })).toEqual({
      emotionKeywords: { "👍": ["赞"] },
    });
    const loaded = loadReactionConfig();
    const allowedEmojis: ReadonlySet<string> = new Set(TELEGRAM_REACTION_EMOJIS);
    expect(Object.keys(loaded.emotionKeywords).length).toBeGreaterThan(0);
    expect(Object.keys(loaded.emotionKeywords).every((emoji) => allowedEmojis.has(emoji))).toBe(true);
  });

  test("拒绝非 Telegram 标准反应、无效关键词和额外字段", () => {
    expect(() => parseReactionConfig({ emotionKeywords: { "😂": ["笑"] } })).toThrow("Unsupported Telegram reaction emoji");
    expect(() => parseReactionConfig({ emotionKeywords: { "👍": [1] } })).toThrow("entry");
    expect(() => parseReactionConfig({ emotionKeywords: {}, extra: true })).toThrow("expected exactly");
  });
});
