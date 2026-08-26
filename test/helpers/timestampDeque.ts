/** TimestampDeque 断言辅助（非测试文件，bun test 不会执行它）。 */

import { TimestampDeque } from "../../packages/libs/timestampDeque";

/** 按给定容量建一个窗口并依次压入 values；不传容量时按元素数留出余量。 */
export function timestampDequeOf(
  values: readonly number[],
  maxCapacity: number = Math.max(1, values.length)
): TimestampDeque {
  const deque = new TimestampDeque(maxCapacity);
  for (const value of values) deque.push(value);
  return deque;
}

/**
 * 窗口内容快照，保持入队顺序。
 *
 * 排空再原样压回，而不是给 TimestampDeque 加一个只有测试用得上的 `last()`：
 * 生产侧从不需要摊平这个窗口，加上去就等于为断言扩生产 API。压回的条数与
 * 排空的完全相同，因此不会撞上容量硬顶。
 */
export function timestampDequeContents(deque: TimestampDeque): number[] {
  const contents: number[] = [];
  for (let value: number | undefined = deque.shift(); value !== undefined; value = deque.shift()) {
    contents.push(value);
  }
  for (const value of contents) deque.push(value);
  return contents;
}
