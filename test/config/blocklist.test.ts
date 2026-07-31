import { describe, expect, test } from "bun:test";
import {
  assertBlocklistProtectedIdentitiesDisjoint,
  loadBlocklistConfig,
  parseBlocklistConfig,
} from "../../packages/config/blocklist";
import { loadWhitelistConfig } from "../../packages/config/whitelist";

describe("static blocklist config", () => {
  test("严格解析用户与频道 ID，并能加载受版本控制的示例", () => {
    expect(parseBlocklistConfig({
      blockedIds: [123456789, -1001234567890],
    })).toEqual({
      blockedIds: [123456789, -1001234567890],
    });

    const loaded = loadBlocklistConfig();
    expect(loaded.blockedIds).toContain(987654321);
    expect(loaded.blockedIds).toContain(-1009876543210);
    expect(Object.isFrozen(loaded)).toBeTrue();
    expect(Object.isFrozen(loaded.blockedIds)).toBeTrue();
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: loaded.blockedIds,
      whitelistIds: loadWhitelistConfig().keys(),
      superAdminId: 1,
      source: "example configs",
    })).not.toThrow();
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

  test("静态或动态名单不能与白名单、超级管理员身份重叠", () => {
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [7],
      whitelistIds: [7, -8],
      superAdminId: 1,
      source: "static blocklist config",
    })).toThrow("protected identity 7");
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [-8],
      whitelistIds: [7, -8],
      superAdminId: 1,
      source: "static blocklist config",
    })).toThrow("protected identity -8");
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [1],
      whitelistIds: [],
      superAdminId: 1,
      source: "persisted dynamic blocklist",
    })).toThrow("protected identity 1");
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [9, -10],
      whitelistIds: [7, 8],
      superAdminId: 1,
      source: "static blocklist config",
    })).not.toThrow();
  });
});
