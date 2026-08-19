/**
 * 存储分区子进程：直接复用 `perf:identity-database` 的六项冷热读写实现。
 *
 * 这里**只做编排**——夹具、批量大小、校验和判定全在
 * `scripts/perf/identityDatabase/` 里，全量基准不另抄一份。抄一份的代价是两处
 * 的批量大小会各自漂移，届时两张表明明写着同一个操作名，却不再是同一件事。
 *
 * 与独立跑 `bun run perf:identity-database` 的唯一差别是 mock 根：那边在系统
 * 临时目录，这里统一落在仓库的 `performance/` 下（见 fullSuite/mockRoot.ts）。
 */

import { dirname } from "node:path";
import { installOutboundGuards } from "../outboundGuard";
import { assertBenchmarkRuntimeRoot } from "./mockRoot";
import { parseStorageOperation } from "./storageOperations";
import { diffProcessIo, readProcessIo } from "./processIo";
import {
  runMainLruReadChild,
  runMainWriteThroughChild,
} from "../identityDatabase/mainThread";
import {
  runColdReadChild,
  runColdWriteChild,
  runHotReadChild,
  runHotWriteChild,
} from "../identityDatabase/storage";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import type { ProcessIoSnapshot } from "./processIo";
import type {
  BenchmarkOperation,
  ChildResult,
} from "../identityDatabase/types";
import type { StorageRound } from "./types";

function runOperation(
  operation: BenchmarkOperation,
  mockRoot: string
): ChildResult | Promise<ChildResult> {
  switch (operation) {
    case "main-lru-read":
      return runMainLruReadChild();
    case "main-write-through-acked":
      return runMainWriteThroughChild(mockRoot);
    case "storage-read-hot-connection":
      return runHotReadChild(mockRoot);
    case "storage-read-cold-connection":
      return runColdReadChild(mockRoot);
    case "storage-write-hot-connection":
      return runHotWriteChild(mockRoot);
    case "storage-write-cold-connection":
      return runColdWriteChild(mockRoot);
  }
}

/** 在本进程的 mock 数据根上跑一项存储操作。 */
async function runStorageChild(
  operation: BenchmarkOperation
): Promise<StorageRound> {
  assertBenchmarkRuntimeRoot(RUNTIME_DATA_ROOT);
  installOutboundGuards();
  const before: ProcessIoSnapshot = readProcessIo();
  const result: ChildResult = await runOperation(
    operation,
    dirname(RUNTIME_DATA_ROOT)
  );
  return { result, io: diffProcessIo(before, readProcessIo()) };
}

/** `--child storage <operation>` 的入口；结果按 JSON 打到 stdout。 */
export async function main(argument: string | undefined): Promise<void> {
  const round: StorageRound = await runStorageChild(
    parseStorageOperation(argument)
  );
  process.stdout.write(`${JSON.stringify(round)}\n`);
}
