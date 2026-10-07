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

/** 窗口内容快照，保持入队顺序；按偏移逐个 peekAt，不改变窗口。 */
export function timestampDequeContents(deque: TimestampDeque): number[] {
  const contents: number[] = [];
  for (let offset: number = 0; offset < deque.size; offset += 1) contents.push(deque.peekAt(offset)!);
  return contents;
}
