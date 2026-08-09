import { describe, expect, test } from "bun:test";
import {
  assertBlocklistProtectedIdentitiesDisjoint,
  loadBlocklistConfig,
  parseBlocklistConfig,
} from "../../packages/config/blocklist";
import type { BlocklistConfig } from "../../packages/types/blocklist";
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
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: loaded.blockedIds,
      whitelistIds: loadWhitelistConfig().keys(),
      superAdminId: 1,
      source: "example configs",
    })).not.toThrow();
  });

  test("解析结果只读，调用方改不动共享单例", () => {
    // 不可变性已从运行期 Object.freeze 移到类型上（见 AGENTS.md 的「常量」一节）：
    // BlocklistConfig 的两层都是 readonly，写入在编译期就被拒。`@ts-expect-error`
    // 本身就是断言——类型哪天被放宽成可写，这两行会因为「预期的错误没有发生」让
    // typecheck 失败（反向验证过：把目标换成合法语句立刻报 TS2578）。
    //
    // **必须挑一份用完即弃的解析结果来试**：`@ts-expect-error` 只压制类型报错，
    // 底下那行代码照样执行。拿共享单例来试就会把它真的改坏，后面的断言全被带偏。
    const probe: BlocklistConfig = parseBlocklistConfig({ blockedIds: [1] });
    // @ts-expect-error 黑名单快照不允许整体替换
    probe.blockedIds = [];
    // @ts-expect-error 黑名单快照不允许就地追加
    probe.blockedIds.push(2);
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
    })).toThrow("disjoint from protected identities");
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [-8],
      whitelistIds: [7, -8],
      superAdminId: 1,
      source: "static blocklist config",
    })).toThrow("disjoint from protected identities");
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [1],
      whitelistIds: [],
      superAdminId: 1,
      source: "persisted dynamic blocklist",
    })).toThrow("disjoint from protected identities");
    expect(() => assertBlocklistProtectedIdentitiesDisjoint({
      blockedIds: [9, -10],
      whitelistIds: [7, 8],
      superAdminId: 1,
      source: "static blocklist config",
    })).not.toThrow();
  });
});
