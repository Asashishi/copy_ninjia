/**
 * 身份策略主线程缓存与 SQLite 的独立进程吞吐、稳定性基准。
 *
 * 父进程在系统临时目录下建立带固定前缀的 mock 数据根，所有 SQLite、
 * WAL/SHM 与 Worker 写透数据都只能落在其中。存储层分别测量同一连接上的热读写
 * 与每批重新打开连接的冷读写；“冷”只代表 SQLite 连接页缓存和 Bun prepared-
 * statement 缓存为空，不声称绕过操作系统页缓存。主线程层直接调用线上 LRU
 * 读取门面，并让写透路径经过真实 Worker 消息、JSONB 事务和 ACK。计时外执行
 * GC、完整性检查与 mock 根清理。
 */

import { rmSync } from "node:fs";
import {
  IDENTITY_READ_CACHE_MAX_ENTRIES,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import {
  INDEPENDENT_PROCESS_SAMPLE_COUNT,
  MAIN_WRITE_THROUGH_WORKING_SET,
  READ_BATCH_SIZE,
  SINGLE_PROCESS_SAMPLE_COUNT,
} from "./identityDatabase/constants";
import {
  runMainLruReadChild,
  runMainWriteThroughChild,
} from "./identityDatabase/mainThread";
import { aggregate } from "./identityDatabase/measurement";
import {
  assertMainBenchmarkDatabase,
  createMainBenchmarkRoot,
  createMockRoot,
  mainBenchmarkEnvironment,
  removeMockRoot,
} from "./identityDatabase/roots";
import {
  runColdReadChild,
  runColdWriteChild,
  runHotReadChild,
  runHotWriteChild,
} from "./identityDatabase/storage";
import type {
  AggregateResult,
  BenchmarkOperation,
  BenchmarkReport,
  ChildResult,
} from "./identityDatabase/types";

/** 固定执行顺序覆盖主线程与 SQLite 的全部热冷路径。 */
const BENCHMARK_OPERATIONS: readonly BenchmarkOperation[] = [
  "main-lru-read",
  "main-write-through-acked",
  "storage-read-hot-connection",
  "storage-read-cold-connection",
  "storage-write-hot-connection",
  "storage-write-cold-connection",
];

async function runOperation(
  operation: BenchmarkOperation,
  mockRoot: string
): Promise<ChildResult> {
  if (operation === "storage-read-hot-connection") {
    return runHotReadChild(mockRoot);
  }
  if (operation === "storage-read-cold-connection") {
    return runColdReadChild(mockRoot);
  }
  if (operation === "storage-write-hot-connection") {
    return runHotWriteChild(mockRoot);
  }
  if (operation === "storage-write-cold-connection") {
    return runColdWriteChild(mockRoot);
  }
  if (operation === "main-lru-read") return runMainLruReadChild();
  return runMainWriteThroughChild(mockRoot);
}

function report(
  aggregates: readonly AggregateResult[],
  samplingMode: BenchmarkReport["samplingMode"],
  samplesPerOperation: number
): BenchmarkReport {
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    samplingMode,
    samplesPerOperation,
    mockDataRoot: "isolated-os-temporary-directory",
    sqliteColdDefinition: "new-connection-per-batch",
    operatingSystemPageCache: "not-evicted-after-fixture-setup",
    storageReadBatchSize: READ_BATCH_SIZE,
    storageWriteTransactionSize: IDENTITY_WRITE_BATCH_MAX_ENTRIES,
    mainLruCapacity: IDENTITY_READ_CACHE_MAX_ENTRIES,
    mainWriteThroughWorkingSet: MAIN_WRITE_THROUGH_WORKING_SET,
    results: aggregates,
  };
}

function runIndependentChild(
  operation: BenchmarkOperation,
  mockRoot: string
): ChildResult {
  const temporaryRoot: string | null = operation === "main-write-through-acked"
    ? createMainBenchmarkRoot(mockRoot)
    : null;
  try {
    const child: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
      cmd: [process.execPath, import.meta.path, "--child", operation, mockRoot],
      stdout: "pipe",
      stderr: "inherit",
      ...(temporaryRoot === null
        ? {}
        : { env: mainBenchmarkEnvironment(temporaryRoot) }),
    });
    if (child.exitCode !== 0) {
      throw new Error(
        `Identity ${operation} benchmark child exited ${child.exitCode}.`
      );
    }
    const result: ChildResult = JSON.parse(
      new TextDecoder().decode(child.stdout)
    ) as ChildResult;
    if (temporaryRoot !== null) {
      assertMainBenchmarkDatabase(temporaryRoot);
    }
    return result;
  } finally {
    if (temporaryRoot !== null) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function runParent(mockRoot: string): BenchmarkReport {
  const aggregates: AggregateResult[] = [];
  for (const operation of BENCHMARK_OPERATIONS) {
    const results: ChildResult[] = [];
    for (
      let sample: number = 0;
      sample < INDEPENDENT_PROCESS_SAMPLE_COUNT;
      sample += 1
    ) {
      results.push(runIndependentChild(operation, mockRoot));
    }
    aggregates.push(aggregate(results));
  }
  return report(
    aggregates,
    "independent-processes",
    INDEPENDENT_PROCESS_SAMPLE_COUNT
  );
}

async function runSingleProcess(mockRoot: string): Promise<BenchmarkReport> {
  const aggregates: AggregateResult[] = [];
  for (const operation of BENCHMARK_OPERATIONS) {
    const results: ChildResult[] = [];
    for (
      let sample: number = 0;
      sample < SINGLE_PROCESS_SAMPLE_COUNT;
      sample += 1
    ) {
      results.push(await runOperation(operation, mockRoot));
    }
    aggregates.push(aggregate(results));
  }
  return report(aggregates, "single-process", SINGLE_PROCESS_SAMPLE_COUNT);
}

function runSingleProcessParent(mockRoot: string): BenchmarkReport {
  const temporaryRoot: string = createMainBenchmarkRoot(mockRoot);
  try {
    const child: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.path,
        "--single-process-child",
        mockRoot,
      ],
      stdout: "pipe",
      stderr: "inherit",
      env: mainBenchmarkEnvironment(temporaryRoot),
    });
    if (child.exitCode !== 0) {
      throw new Error(
        `Identity single-process benchmark child exited ${child.exitCode}.`
      );
    }
    const result: BenchmarkReport = JSON.parse(
      new TextDecoder().decode(child.stdout)
    ) as BenchmarkReport;
    assertMainBenchmarkDatabase(temporaryRoot);
    return result;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (Bun.argv[2] === "--child") {
  const operation: string | undefined = Bun.argv[3];
  const mockRoot: string | undefined = Bun.argv[4];
  if (!BENCHMARK_OPERATIONS.includes(operation as BenchmarkOperation)) {
    throw new Error("Expected a supported identity benchmark operation.");
  }
  if (mockRoot === undefined) {
    throw new Error("Identity benchmark child requires its temporary mock root.");
  }
  const result: ChildResult = await runOperation(
    operation as BenchmarkOperation,
    mockRoot
  );
  await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
} else if (Bun.argv[2] === "--single-process-child") {
  const mockRoot: string | undefined = Bun.argv[3];
  if (mockRoot === undefined) {
    throw new Error("Identity benchmark child requires its temporary mock root.");
  }
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify(await runSingleProcess(mockRoot), null, 2)}\n`
  );
} else if (Bun.argv[2] === "--single-process") {
  const mockRoot: string = createMockRoot();
  try {
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify(runSingleProcessParent(mockRoot), null, 2)}\n`
    );
  } finally {
    removeMockRoot(mockRoot);
  }
} else {
  const mockRoot: string = createMockRoot();
  try {
    await Bun.write(Bun.stdout, `${JSON.stringify(runParent(mockRoot), null, 2)}\n`);
  } finally {
    removeMockRoot(mockRoot);
  }
}
