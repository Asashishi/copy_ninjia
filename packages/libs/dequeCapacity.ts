/**
 * 两个有界环形队列共用的构造校验。
 *
 * 只抽校验，不抽存储：TimestampDeque 的 backing array 是纯 `number[]`，而
 * BoundedDeque 为了立刻解除对已淘汰对象的引用必须往槽位写 `undefined`。让前者
 * 继承后者会把每消息滑动窗口那份紧凑数值数组换成带空洞的引用数组，正是
 * AGENTS.md「热调用点必须保持类型和对象 shape 稳定」要避免的方向。
 */
export function assertDequeCapacities(
  maxCapacity: number,
  initialCapacity: number
): void {
  if (!Number.isSafeInteger(maxCapacity) || maxCapacity <= 0) {
    throw new RangeError("maxCapacity must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(initialCapacity) ||
    initialCapacity <= 0 ||
    initialCapacity > maxCapacity
  ) {
    throw new RangeError(
      "initialCapacity must be a positive safe integer no greater than maxCapacity"
    );
  }
}
