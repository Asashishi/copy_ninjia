import { describe, expect, test } from "bun:test";
import {
  loadBlocklistConfig,
  parseBlocklistConfig,
} from "../../packages/config/blocklist";

describe("static blocklist config", () => {
  test("严格解析用户与频道 ID，并能加载受版本控制的示例", () => {
    expect(parseBlocklistConfig({
      blockedIds: [123456789, -1001234567890],
    })).toEqual({
      blockedIds: [123456789, -1001234567890],
    });

    const loaded = loadBlocklistConfig();
    expect(loaded.blockedIds).toContain(123456789);
    expect(loaded.blockedIds).toContain(-1001234567890);
    expect(Object.isFrozen(loaded)).toBeTrue();
    expect(Object.isFrozen(loaded.blockedIds)).toBeTrue();
  });

  test("拒绝错误结构、额外字段、零、小数、非数字、越界与重复 ID", () => {
    for (const invalid of [
      [],
      {},
      { blockedIds: [], extra: true },
      { blockedIds: [0] },
      { blockedIds: [1.5] },
      { blockedIds: ["1"] },
      { blockedIds: [Number.MAX_SAFE_INTEGER + 1] },
      { blockedIds: [7, 7] },
    ]) {
      expect(() => parseBlocklistConfig(invalid)).toThrow();
    }
  });
});
