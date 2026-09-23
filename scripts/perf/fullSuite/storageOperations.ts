/**
 * 存储分区的操作表与参数解析。
 *
 * 本文件只放操作表与参数解析，供父进程按序 spawn。`fullSuite/storage.ts` 会
 * 静态 import 生产模块，父进程不 import 它（约束见 fullSuite/mockRoot.ts 的模块
 * 头注）。
 */

import type { BenchmarkOperation } from "../identityDatabase/types";

/** 存储分区固定按这个顺序出数，覆盖主线程与 SQLite 的全部冷热路径。 */
export const STORAGE_OPERATIONS: readonly BenchmarkOperation[] = [
  "main-lru-read",
  "main-write-through-acked",
  "storage-read-hot-connection",
  "storage-read-cold-connection",
  "storage-write-hot-connection",
  "storage-write-cold-connection",
];

/** 命令行参数到操作名的严格解析；未知值直接失败，不落到某个默认操作。 */
export function parseStorageOperation(
  value: string | undefined
): BenchmarkOperation {
  const operation: BenchmarkOperation | undefined = STORAGE_OPERATIONS.find(
    (candidate: BenchmarkOperation): boolean => candidate === value
  );
  if (operation === undefined) {
    throw new Error(
      `Storage child expects one of ${STORAGE_OPERATIONS.join("|")}.`
    );
  }
  return operation;
}
