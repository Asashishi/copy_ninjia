import { describe, expect, test } from "bun:test";
import { exhaustiveList } from "../../packages/consts/exhaustiveList";

type Fruit = "apple" | "pear" | "plum";

describe("exhaustiveList", () => {
  test("覆盖全部成员时原样返回同一个数组，顺序即字面量顺序", () => {
    const items: readonly Fruit[] = ["plum", "apple", "pear"];
    expect(exhaustiveList<Fruit>()(items as readonly ["plum", "apple", "pear"])).toBe(items);
    expect(exhaustiveList<Fruit>()(["pear", "plum", "apple"])).toEqual(["pear", "plum", "apple"]);
  });

  test("漏掉成员或混入联合以外的值都在编译期报错", () => {
    const missing = (): readonly Fruit[] =>
      // @ts-expect-error 漏掉 "plum"，实参类型退化成 never。
      exhaustiveList<Fruit>()(["apple", "pear"]);
    const foreign = (): readonly Fruit[] =>
      // @ts-expect-error "grape" 不属于 Fruit。
      exhaustiveList<Fruit>()(["apple", "pear", "plum", "grape"]);
    expect(typeof missing).toBe("function");
    expect(typeof foreign).toBe("function");
  });
});
