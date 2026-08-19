/**
 * 各性能基准共用的 JSC 堆快照。
 *
 * 三个基准入口原先各留一份逐字相同的实现和接口；同一个 `heapSize` 字段在三份
 * 报告里必须是同一件事，实现就只能有一份。
 */

import { heapStats } from "bun:jsc";

/**
 * 一次堆快照。
 *
 * **`heapStats()` 的计数只在 GC 边界更新**，不是实时的：把 5 万个确定存活的对象
 * 分配出来后立刻读，obj/heap 增量都是 0；同一批对象在 `Bun.gc(true)` 之后再读，
 * 才如实显示 134367 个对象、4601132 字节（Bun 1.3.14 控制组实测）。因此两次快照
 * 之间**必须隔一次 GC**，否则读到的恒为 0，而不是「没有分配」。
 */
export interface HeapSnapshot {
  readonly heapSize: number;
  readonly extraMemorySize: number;
  readonly objectCount: number;
}

/** 读一次当前 JSC 堆计数；语义见 `HeapSnapshot`。 */
export function snapshotHeap(): HeapSnapshot {
  const stats: ReturnType<typeof heapStats> = heapStats();
  return {
    heapSize: stats.heapSize,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
  };
}
