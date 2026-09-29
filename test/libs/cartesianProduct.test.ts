import { expect, test } from "bun:test";
import { cartesianProduct } from "../../packages/libs/cartesianProduct";

test("组合顺序与同顺序的嵌套循环一致：第一个维度变化最慢，最后一个最快", () => {
  expect(cartesianProduct({ letter: ["a", "b"], digit: [1, 2], flag: [false, true] })).toEqual([
    { letter: "a", digit: 1, flag: false },
    { letter: "a", digit: 1, flag: true },
    { letter: "a", digit: 2, flag: false },
    { letter: "a", digit: 2, flag: true },
    { letter: "b", digit: 1, flag: false },
    { letter: "b", digit: 1, flag: true },
    { letter: "b", digit: 2, flag: false },
    { letter: "b", digit: 2, flag: true },
  ]);
});

test("字段按维度声明顺序写入，每个组合都是新对象", () => {
  const combinations = cartesianProduct({ second: [1, 2], first: ["x"] });
  expect(Object.keys(combinations[0]!)).toEqual(["second", "first"]);
  expect(combinations[0]).not.toBe(combinations[1]);
});

test("任一维度为空时没有组合", () => {
  expect(cartesianProduct({ kept: [1, 2], empty: [] })).toEqual([]);
});

test("字面量取值保持字面量类型", () => {
  const combinations = cartesianProduct({ kind: ["direct", "random"], limit: [1] });
  const check = (): void => {
    const kind: "direct" | "random" = combinations[0]!.kind;
    // @ts-expect-error 字面量维度不会放宽成任意字符串。
    const widened: "other" = combinations[0]!.kind;
    void kind;
    void widened;
  };
  expect(check).toBeDefined();
});
