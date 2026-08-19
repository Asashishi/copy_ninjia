/**
 * 存储分区的操作表与参数解析。
 *
 * 与 `fullSuite/storage.ts` 分开，是因为父进程也要按这张表排队 spawn，而
 * storage.ts 会静态 import 生产模块——父进程一旦 import 它，就把整张生产模块图
 * 拉进了那个本该只负责 spawn 的进程（约束见 fullSuite/mockRoot.ts 的模块头注）。
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
