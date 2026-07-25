import { describe, expect, test } from "bun:test";
import { loadMoodConfig, parseMoodConfig } from "../../packages/config/mood";

describe("mood config", () => {
  test("严格解析心情档位，并能加载全部部署配置", () => {
    const parsed = parseMoodConfig({
      moods: [
        { name: "开心", weight: 60, instruction: "很开心。", weatherMultipliers: { clear: 1.5 }, timeMultipliers: { night: 0.8 } },
        { name: "困", weight: 40, instruction: "很困。" },
      ],
    });
    expect(parsed.moods.map((mood) => mood.name)).toEqual(["开心", "困"]);
    expect(parsed.moods[0]!.weatherMultipliers).toEqual({ clear: 1.5 });

    const loaded = loadMoodConfig();
    expect(loaded.moods.length).toBeGreaterThan(0);
    expect(loaded.moods.reduce((sum, mood) => sum + mood.weight, 0)).toBe(100);
  });

  test("base weight 总和不为 100 时直接报错", () => {
    expect(() => parseMoodConfig({
      moods: [
        { name: "开心", weight: 60, instruction: "很开心。" },
        { name: "困", weight: 30, instruction: "很困。" },
      ],
    })).toThrow("Mood config weights must sum to 100, got 90");
  });

  test("拒绝额外字段、空列表、重名档位和非法权重/文案", () => {
    expect(() => parseMoodConfig({ moods: [], extra: true })).toThrow("expected exactly");
    expect(() => parseMoodConfig({ moods: [] })).toThrow("must not be empty");
    expect(() => parseMoodConfig({
      moods: [
        { name: "开心", weight: 50, instruction: "很开心。" },
        { name: "开心", weight: 50, instruction: "还是开心。" },
      ],
    })).toThrow("Duplicate mood config entry name");
    expect(() => parseMoodConfig({ moods: [{ name: "开心", weight: 100, instruction: "很开心。", surprise: 1 }] })).toThrow("Unknown key");
    expect(() => parseMoodConfig({ moods: [{ name: "开心", weight: -1, instruction: "很开心。" }] })).toThrow("weight must be a positive integer");
    expect(() => parseMoodConfig({
      moods: [
        { name: "开心", weight: 66.5, instruction: "很开心。" },
        { name: "困", weight: 33.5, instruction: "很困。" },
      ],
    })).toThrow("weight must be a positive integer");
    expect(() => parseMoodConfig({ moods: [{ name: "开心", weight: 100, instruction: " " }] })).toThrow("instruction must be a non-empty string");
    expect(() => parseMoodConfig({ moods: [{ name: "", weight: 100, instruction: "很开心。" }] })).toThrow("name must be a non-empty string");
  });

  test("拒绝未知倍率桶和非正倍率", () => {
    expect(() => parseMoodConfig({
      moods: [{ name: "开心", weight: 100, instruction: "很开心。", weatherMultipliers: { sunny: 1.5 } }],
    })).toThrow("Unknown bucket in weatherMultipliers");
    expect(() => parseMoodConfig({
      moods: [{ name: "开心", weight: 100, instruction: "很开心。", timeMultipliers: { midnight: 1.2 } }],
    })).toThrow("Unknown bucket in timeMultipliers");
    expect(() => parseMoodConfig({
      moods: [{ name: "开心", weight: 100, instruction: "很开心。", timeMultipliers: { night: 0 } }],
    })).toThrow("expected a positive finite number");
  });
});
