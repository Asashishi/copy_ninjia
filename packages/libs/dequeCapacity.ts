/**
 * 两个有界环形队列共用的构造校验。
 *
 * 只抽校验，不抽存储：TimestampDeque 的 backing array 是纯 `number[]`，
 * BoundedDeque 往槽位写 `undefined` 以解除对已淘汰对象的引用。
 *
 * 两者的环形下标一律用「相加后一次条件减」折回环内，不用取模：下标最大只到
 * `2 * values.length - 1`，一次比较即可折回。新增环形操作必须沿用同一写法。
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
