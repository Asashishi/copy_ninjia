import { describe, expect, test } from "bun:test";
import { LruCache } from "../../packages/libs/lruCache";

describe("LruCache", () => {
  test("超容量淘汰最久未使用的一项", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  test("get 命中会续命，让它免于被淘汰", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  test("peek 查看不影响淘汰顺位", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.peek("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  test("set 覆盖已有键也视为一次使用", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 9);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(9);
    expect(cache.has("b")).toBe(false);
  });

  test("delete 移除条目", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.delete("a")).toBe(false);
  });

  test("拒绝无效上限", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(-1)).toThrow(RangeError);
  });

  test("回归：get 命中一个值为 undefined 的键时不当成未命中，且照常续命", () => {
    const cache = new LruCache<string, number | undefined>(2);
    cache.set("a", undefined);
    cache.set("b", 2);
    expect(cache.has("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    cache.set("c", 3); // 容量满，若 "a" 的 get 没有正确续命会被误判成最久未使用而淘汰
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });
});
