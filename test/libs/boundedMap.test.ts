import { describe, expect, test } from "bun:test";
import { setBoundedMapValue } from "../../src/libs/boundedMap";

describe("setBoundedMapValue", () => {
  test("新增键越界时淘汰最早项", () => {
    const map = new Map([["a", 1], ["b", 2]]);
    setBoundedMapValue(map, "c", 3, 2);
    expect([...map.entries()]).toEqual([["b", 2], ["c", 3]]);
  });

  test("更新已有键不淘汰其它项", () => {
    const map = new Map([["a", 1], ["b", 2]]);
    setBoundedMapValue(map, "a", 9, 2);
    expect([...map.entries()]).toEqual([["a", 9], ["b", 2]]);
  });

  test("键为 undefined 时仍可正确淘汰", () => {
    const map = new Map<string | undefined, number>([[undefined, 1]]);
    setBoundedMapValue(map, "a", 2, 1);
    expect([...map.entries()]).toEqual([["a", 2]]);
  });

  test("拒绝无效上限", () => {
    expect(() => setBoundedMapValue(new Map(), "a", 1, 0)).toThrow(RangeError);
  });
});
