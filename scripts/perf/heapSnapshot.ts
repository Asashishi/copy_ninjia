/**
 * 各性能基准共用的 JSC 堆快照。
 *
 * 三个基准入口共用这份实现，保证报告里的 `heapSize` 字段口径一致。
 */

import { heapStats } from "bun:jsc";

/**
 * 一次堆快照。
 *
 * `heapStats()` 的计数只在 GC 边界更新，不是实时值。两次用于比较的快照之间必须
 * 执行一次 GC，使新分配且仍存活的对象进入本次堆统计。
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
