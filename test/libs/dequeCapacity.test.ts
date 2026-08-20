import { describe, expect, test } from "bun:test";
import { assertDequeCapacities } from "../../packages/libs/dequeCapacity";
import { BoundedDeque } from "../../packages/libs/boundedDeque";
import { TimestampDeque } from "../../packages/libs/timestampDeque";

/**
 * 两个有界环形队列共用的构造校验。
 *
 * 它是这两个容器唯一的入口检查：放过一个非法容量，`new Array(n)` 要么抛
 * `Invalid array length`（负数/非整数），要么静默造出一个永远装不下东西的
 * 零容量数组——后者会让滑动窗口在生产里悄悄丢弃每一条记录。因此这里逐条钉住
 * 「什么样的取值必须当场拒绝」，而不只是测正常路径。
 */
describe("assertDequeCapacities", () => {
  test("接受合法组合：initialCapacity 可以等于 maxCapacity", () => {
    expect(() => { assertDequeCapacities(1, 1); }).not.toThrow();
    expect(() => { assertDequeCapacities(1_024, 4); }).not.toThrow();
    expect(() => { assertDequeCapacities(8, 8); }).not.toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    "maxCapacity=%p 必须以 RangeError 当场拒绝",
    (maxCapacity: number) => {
      expect(() => { assertDequeCapacities(maxCapacity, 1); })
        .toThrow(new RangeError("maxCapacity must be a positive safe integer"));
    }
  );

  test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "initialCapacity=%p 必须以 RangeError 当场拒绝",
    (initialCapacity: number) => {
      expect(() => { assertDequeCapacities(8, initialCapacity); })
        .toThrow(new RangeError(
          "initialCapacity must be a positive safe integer no greater than maxCapacity"
        ));
    }
  );

  test("initialCapacity 不得大于 maxCapacity", () => {
    expect(() => { assertDequeCapacities(4, 5); })
      .toThrow(new RangeError(
        "initialCapacity must be a positive safe integer no greater than maxCapacity"
      ));
  });

  test("两个容器的构造函数都真的接上了这道校验", () => {
    expect(() => new BoundedDeque<number>(0)).toThrow(RangeError);
    expect(() => new TimestampDeque(0)).toThrow(RangeError);
    expect(() => new BoundedDeque<number>(4, 5)).toThrow(RangeError);
    expect(() => new TimestampDeque(4, 5)).toThrow(RangeError);
  });
});
