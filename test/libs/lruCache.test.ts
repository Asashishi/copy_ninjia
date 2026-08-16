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

  test("迭代按当前 LRU 顺序出条目，keys() 与之一致", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect([...cache]).toEqual([["a", 1], ["b", 2], ["c", 3]]);

    cache.get("a"); // 续命把 a 挪到最新一端
    expect([...cache.keys()]).toEqual(["b", "c", "a"]);
    expect([...cache].map(([key]: readonly [string, number]): string => key)).toEqual([...cache.keys()]);
  });

  // 迭代不算一次使用，是「一边遍历缓存、一边有别的代码在读它」得以安全的前提：
  // chatStateCache 的十余处遍历（连带封禁群清单、各处 managed 群清扫、lockdown
  // 收养与恢复……）都建立在这条承诺上。
  test("迭代不刷新条目热度：遍历一遍之后，被淘汰的仍是遍历前最久未使用的那个", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);

    for (const _entry of cache) { /* 只遍历，不读值 */ }
    for (const _key of cache.keys()) { /* 同上 */ }

    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  test("迭代给的是惰性视图而不是快照数组：取到迭代器之后写入的条目照样遍历得到", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);

    const iterator = cache[Symbol.iterator]();
    expect(iterator.next().value).toEqual(["a", 1]);
    cache.set("c", 3);

    expect([...iterator]).toEqual([["b", 2], ["c", 3]]);
  });

  // 下面四条锁住「一边遍历、一边改写同一份缓存」的语义。实现从「Map 删了再插」
  // 换成侵入式双向链表时，这一族是唯一可能悄悄改掉行为的地方：
  // antiRaid/lockdownMirror.ts 的 recoverAbandonedLockdowns 正是这样用的——遍历
  // chatStateCache，就地为每个仍挂着 lockdown 的群发起权限恢复，而那条链路第一句
  // 同步就要 getChatStateCache().get(同一个 chatId)。一旦迭代在那里提前结束，
  // 排在后面的群会一个都恢复不到，而且没有任何报错。
  test("迭代中删除当前停留的这一条：其余条目照常遍历完，不会提前结束", () => {
    const cache = new LruCache<string, number>(8);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);

    const seen: string[] = [];
    for (const [key] of cache) {
      seen.push(key);
      if (key === "b") cache.delete("b");
    }
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  test("迭代中删除尚未访问的条目：跳过它，其余照常", () => {
    const cache = new LruCache<string, number>(8);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);

    const seen: string[] = [];
    for (const [key] of cache) {
      seen.push(key);
      if (key === "b") cache.delete("c");
    }
    expect(seen).toEqual(["a", "b", "d"]);
  });

  test("迭代中 get 尚未访问的条目：它被挪到最新端，随后在末尾恰好出现一次", () => {
    const cache = new LruCache<string, number>(8);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);

    const seen: string[] = [];
    for (const [key] of cache) {
      seen.push(key);
      if (key === "b") cache.get("c");
    }
    expect(seen).toEqual(["a", "b", "d", "c"]);
  });

  test("迭代中 get 当前停留的这一条：不漏掉后面的条目，且迭代必须终止", () => {
    const cache = new LruCache<string, number>(8);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);

    const seen: string[] = [];
    // 每次产出都把它挪到最新端。哨兵防止实现回退成死循环时把测试挂住——
    // 旧的 Map 实现在这里就是无限产出同一条。
    for (const [key] of cache) {
      seen.push(key);
      if (key === "b") cache.get("b");
      if (seen.length > 32) break;
    }
    expect(seen).toEqual(["a", "b", "c", "d", "b"]);
    // 四条都至少访问到了一次，这才是 recoverAbandonedLockdowns 依赖的性质。
    expect(new Set(seen)).toEqual(new Set(["a", "b", "c", "d"]));
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
