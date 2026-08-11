/**
 * 身份策略主线程缓存与 SQLite 的独立进程吞吐、稳定性基准。
 *
 * 独立进程模式为每个样本建临时库；单进程模式让一个测量子进程连续复测，但仍
 * 由父进程提供独立临时数据根。存储层按一次 update 的双表批量冷读和生产 128
 * 行显式事务计数；主线程层直接调用线上 LRU 读取门面，并让写透路径经过真实
 * Worker 消息、JSONB 事务和 ACK。计时外执行 GC、完整性检查与临时库清理。
 */

import { heapStats } from "bun:jsc";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_READ_CACHE_MAX_ENTRIES,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../packages/consts/environment";
import { RUNTIME_DATA_ROOT } from "../../packages/consts/paths";
import {
  blocklistEntryCache,
  resetIdentityStorageCache,
  unacknowledgedWhitelistWrites,
  whitelistEntryCache,
} from "../../packages/cache/main/identityStorage";
import {
  assertIdentityDatabaseIntegrity,
  assertIdentityDatabaseJsonbStorage,
  clearIdentityBusinessTables,
  closeIdentityDatabase,
  commitIdentityDatabaseChanges,
  createIdentityDatabase,
  enableIdentityDatabaseWal,
  openIdentityDatabase,
  readStoredIdentityPolicies,
  seedIdentityDatabase,
} from "../../packages/database/interact/identity";
import {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  hydrateIdentityStorageCounts,
  queueIdentityPolicyWrite,
} from "../../packages/infra/identityStorage";
import {
  flushDiskIODomain,
  initDiskIO,
  loadPersistedData,
  terminateDiskIO,
} from "../../packages/infra/diskIO";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import type { LoadedData } from "../../packages/types/diskIO";
import type {
  BlocklistEntryData,
  WhitelistEntryData,
} from "../../packages/types/identityPolicy";
import type { FlushResult } from "../../packages/types/lifecycle";
import type {
  IdentityDatabase,
  IdentityDatabaseChange,
  StoredIdentityPolicyRow,
} from "../../packages/types/identityDatabase";

type BenchmarkOperation =
  | "storage-read"
  | "storage-write"
  | "main-lru-read"
  | "main-write-through-acked";

interface HeapSnapshot {
  readonly heapSize: number;
  readonly extraMemorySize: number;
  readonly objectCount: number;
}

interface DatabaseFixture {
  readonly root: string;
  readonly database: IdentityDatabase;
}

interface ChildResult {
  readonly operation: BenchmarkOperation;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly operations: number;
  readonly batches: number;
  readonly elapsedMs: number;
  readonly throughputPerSecond: number;
  readonly meanBatchLatencyMs: number;
  readonly retainedHeapDelta: number;
  readonly retainedExtraMemoryDelta: number;
  readonly retainedObjectDelta: number;
  readonly gcBeforeMs: number;
  readonly gcAfterMs: number;
  readonly checksum: number;
}

interface AggregateResult {
  readonly operation: BenchmarkOperation;
  readonly samples: number;
  readonly operationsPerSample: number;
  readonly batchesPerSample: number;
  readonly averageThroughputPerSecond: number;
  readonly minThroughputPerSecond: number;
  readonly maxThroughputPerSecond: number;
  readonly coefficientOfVariationPercent: number;
  readonly averageBatchLatencyMs: number;
  readonly averageRetainedHeapDelta: number;
  readonly averageRetainedExtraMemoryDelta: number;
  readonly averageRetainedObjectDelta: number;
  readonly averageGcBeforeMs: number;
  readonly averageGcAfterMs: number;
  readonly checksum: number;
}

interface BenchmarkReport {
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly samplingMode: "independent-processes" | "single-process";
  readonly samplesPerOperation: number;
  readonly storageReadBatchSize: number;
  readonly storageWriteTransactionSize: number;
  readonly mainLruCapacity: number;
  readonly mainWriteThroughWorkingSet: number;
  readonly results: readonly AggregateResult[];
}

/** 每个读样本执行的双表批量查询次数。 */
const READ_BATCH_COUNT: number = 25_000;
/** 一次冷 update 预热的固定身份数。 */
const READ_BATCH_SIZE: number = 8;
/** 读库基数保持在单份 LRU 上限，避免只量到极小 B-tree。 */
const READ_FIXTURE_SIZE: number = 8_192;
/** 每个写样本提交的 128 行事务数。 */
const WRITE_TRANSACTION_COUNT: number = 512;
/** 主线程 LRU 每个样本读取的 update 批次数。 */
const MAIN_LRU_READ_BATCH_COUNT: number = 1_000_000;
/** 主线程写透使用的身份工作集；两倍操作恰好完成一次写入和删除。 */
const MAIN_WRITE_THROUGH_WORKING_SET: number = 4_096;
/** 主线程写透每个样本的计时操作数。 */
const MAIN_WRITE_THROUGH_OPERATION_COUNT: number = 65_536;
/** 每项操作的独立进程样本数。 */
const INDEPENDENT_PROCESS_SAMPLE_COUNT: number = 5;
/** 同一测量进程内连续复测每项操作的样本数。 */
const SINGLE_PROCESS_SAMPLE_COUNT: number = 3;
/** 写透基准唯一允许使用的数据根前缀，防止内部 CLI 误写部署数据库。 */
const MAIN_BENCHMARK_ROOT_PREFIX: string = ".identity-main-bench-";

const WHITE_ENTRY: Readonly<WhitelistEntryData> = {
  permissions: DEFAULT_WHITELIST_PERMISSIONS,
  meta: { firstName: "benchmark", lastName: "", username: "" },
};

const BLACK_ENTRY: Readonly<BlocklistEntryData> = {
  blockedAt: "2026/08/11 00:00:00",
  meta: { firstName: "benchmark", lastName: "", username: "" },
};

const WHITE_DATA: string = encodeWhitelistEntryData(WHITE_ENTRY);

const BLACK_DATA: string = encodeBlocklistEntryData(BLACK_ENTRY);

function snapshotHeap(): HeapSnapshot {
  const stats: ReturnType<typeof heapStats> = heapStats();
  return {
    heapSize: stats.heapSize,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
  };
}

function forceGc(): number {
  const startedAt: number = performance.now();
  Bun.gc(true);
  return performance.now() - startedAt;
}

function createFixture(): DatabaseFixture {
  const root: string = mkdtempSync(join(process.cwd(), ".identity-database-bench-"));
  const path: string = join(root, "storage.sqlite");
  createIdentityDatabase(path);
  enableIdentityDatabaseWal(path);
  const database: IdentityDatabase = openIdentityDatabase({ path });
  seedIdentityDatabase(database, {
    metadata: [{
      key: IDENTITY_DATABASE_SCHEMA_KEY,
      data: IDENTITY_DATABASE_SCHEMA_DATA,
    }],
    whitelist: [],
    blocklist: [],
    removals: [],
  });
  return { root, database };
}

function closeFixture(fixture: DatabaseFixture): void {
  closeIdentityDatabase(fixture.database);
  rmSync(fixture.root, { recursive: true, force: true });
}

function readIds(): readonly number[] {
  const ids: number[] = new Array<number>(READ_BATCH_SIZE);
  for (let index: number = 0; index < READ_BATCH_SIZE; index += 1) {
    ids[index] = index + 1;
  }
  return ids;
}

function seedReadFixture(database: IdentityDatabase): void {
  const whitelist: StoredIdentityPolicyRow[] = [];
  const blocklist: StoredIdentityPolicyRow[] = [];
  for (let id: number = 1; id <= READ_FIXTURE_SIZE; id += 1) {
    if ((id & 1) === 0) blocklist.push({ id, data: BLACK_DATA });
    else whitelist.push({ id, data: WHITE_DATA });
  }
  seedIdentityDatabase(database, {
    metadata: [],
    whitelist,
    blocklist,
    removals: [],
  });
}

function runReadBatches(
  database: IdentityDatabase,
  ids: readonly number[],
  batches: number
): number {
  let checksum: number = 0;
  for (let batch: number = 0; batch < batches; batch += 1) {
    checksum += readStoredIdentityPolicies(database, "whitelist", ids).length;
    checksum += readStoredIdentityPolicies(database, "blocklist", ids).length;
  }
  return checksum;
}

function createWriteBatches(): readonly ReadonlyMap<number, IdentityDatabaseChange>[] {
  const batches: ReadonlyMap<number, IdentityDatabaseChange>[] = [];
  let id: number = 1;
  for (let batch: number = 0; batch < WRITE_TRANSACTION_COUNT; batch += 1) {
    const changes: Map<number, IdentityDatabaseChange> = new Map();
    for (
      let offset: number = 0;
      offset < IDENTITY_WRITE_BATCH_MAX_ENTRIES;
      offset += 1
    ) {
      changes.set(id, { data: WHITE_DATA });
      id += 1;
    }
    batches.push(changes);
  }
  return batches;
}

function runWriteBatches(
  database: IdentityDatabase,
  batches: readonly ReadonlyMap<number, IdentityDatabaseChange>[]
): number {
  const empty: ReadonlyMap<number, IdentityDatabaseChange> = new Map();
  let checksum: number = 0;
  for (const whitelist of batches) {
    commitIdentityDatabaseChanges(database, {
      whitelist,
      blocklist: empty,
      removals: empty,
    });
    checksum += whitelist.size;
  }
  return checksum;
}

function seedMainLru(): void {
  resetIdentityStorageCache();
  for (let id: number = 1; id <= READ_FIXTURE_SIZE; id += 1) {
    if ((id & 1) === 0) {
      whitelistEntryCache.set(id, null);
      blocklistEntryCache.set(id, BLACK_ENTRY);
    } else {
      whitelistEntryCache.set(id, WHITE_ENTRY);
      blocklistEntryCache.set(id, null);
    }
  }
}

function runMainLruReadBatches(batches: number): number {
  let checksum: number = 0;
  let id: number = 1;
  for (let batch: number = 0; batch < batches; batch += 1) {
    for (let offset: number = 0; offset < READ_BATCH_SIZE; offset += 1) {
      if (cachedWhitelistEntry(id) !== undefined) checksum += 1;
      if (cachedBlocklistEntry(id) !== undefined) checksum += 1;
      id += 1;
      if (id > READ_FIXTURE_SIZE) id = 1;
    }
  }
  return checksum;
}

function seedMainWriteThroughCache(): void {
  for (let id: number = 1; id <= MAIN_WRITE_THROUGH_WORKING_SET; id += 1) {
    whitelistEntryCache.set(id, null);
    blocklistEntryCache.set(id, null);
  }
}

function runMainWriteThroughOperations(
  operations: number,
  startingOperation: number
): number {
  let checksum: number = 0;
  for (let offset: number = 0; offset < operations; offset += 1) {
    const operation: number = startingOperation + offset;
    const id: number = operation % MAIN_WRITE_THROUGH_WORKING_SET + 1;
    const cycle: number = Math.floor(operation / MAIN_WRITE_THROUGH_WORKING_SET);
    const value: Readonly<WhitelistEntryData> | null = (cycle & 1) === 0
      ? WHITE_ENTRY
      : null;
    if (!queueIdentityPolicyWrite("whitelist", id, value)) {
      throw new Error(`Main-thread write-through rejected operation ${operation}.`);
    }
    checksum += 1;
  }
  return checksum;
}

interface MeasuredResultOptions {
  readonly operation: BenchmarkOperation;
  readonly operations: number;
  readonly batches: number;
  readonly run: () => number;
}

interface AsyncMeasuredResultOptions {
  readonly operation: BenchmarkOperation;
  readonly operations: number;
  readonly batches: number;
  readonly run: () => Promise<number>;
}

function measuredResult({
  operation,
  operations,
  batches,
  run,
}: MeasuredResultOptions): ChildResult {
  const gcBeforeMs: number = forceGc();
  const before: HeapSnapshot = snapshotHeap();
  const startedAt: number = performance.now();
  const checksum: number = run();
  const elapsedMs: number = performance.now() - startedAt;
  const gcAfterMs: number = forceGc();
  const retained: HeapSnapshot = snapshotHeap();
  return {
    operation,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    operations,
    batches,
    elapsedMs,
    throughputPerSecond: operations * 1_000 / elapsedMs,
    meanBatchLatencyMs: elapsedMs / batches,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    gcBeforeMs,
    gcAfterMs,
    checksum,
  };
}

async function measuredResultAsync({
  operation,
  operations,
  batches,
  run,
}: AsyncMeasuredResultOptions): Promise<ChildResult> {
  const gcBeforeMs: number = forceGc();
  const before: HeapSnapshot = snapshotHeap();
  const startedAt: number = performance.now();
  const checksum: number = await run();
  const elapsedMs: number = performance.now() - startedAt;
  const gcAfterMs: number = forceGc();
  const retained: HeapSnapshot = snapshotHeap();
  return {
    operation,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    operations,
    batches,
    elapsedMs,
    throughputPerSecond: operations * 1_000 / elapsedMs,
    meanBatchLatencyMs: elapsedMs / batches,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    gcBeforeMs,
    gcAfterMs,
    checksum,
  };
}

function runReadChild(): ChildResult {
  const fixture: DatabaseFixture = createFixture();
  try {
    seedReadFixture(fixture.database);
    const ids: readonly number[] = readIds();
    runReadBatches(fixture.database, ids, 2_000);
    const operations: number = READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "storage-read",
      operations,
      batches: READ_BATCH_COUNT,
      run: (): number => runReadBatches(fixture.database, ids, READ_BATCH_COUNT),
    });
    if (result.checksum !== operations) {
      throw new Error(`Read benchmark checksum mismatch: ${result.checksum}.`);
    }
    assertIdentityDatabaseIntegrity(fixture.database);
    return result;
  } finally {
    closeFixture(fixture);
  }
}

function runWriteChild(): ChildResult {
  const fixture: DatabaseFixture = createFixture();
  try {
    const warmup: readonly ReadonlyMap<number, IdentityDatabaseChange>[] =
      createWriteBatches().slice(0, 16);
    runWriteBatches(fixture.database, warmup);
    clearIdentityBusinessTables(fixture.database);
    const batches: readonly ReadonlyMap<number, IdentityDatabaseChange>[] =
      createWriteBatches();
    const operations: number = WRITE_TRANSACTION_COUNT *
      IDENTITY_WRITE_BATCH_MAX_ENTRIES;
    const result: ChildResult = measuredResult({
      operation: "storage-write",
      operations,
      batches: WRITE_TRANSACTION_COUNT,
      run: (): number => runWriteBatches(fixture.database, batches),
    });
    if (result.checksum !== operations) {
      throw new Error(`Write benchmark checksum mismatch: ${result.checksum}.`);
    }
    assertIdentityDatabaseIntegrity(fixture.database);
    return result;
  } finally {
    closeFixture(fixture);
  }
}

function runMainLruReadChild(): ChildResult {
  try {
    seedMainLru();
    runMainLruReadBatches(50_000);
    const operations: number = MAIN_LRU_READ_BATCH_COUNT * READ_BATCH_SIZE;
    const result: ChildResult = measuredResult({
      operation: "main-lru-read",
      operations,
      batches: MAIN_LRU_READ_BATCH_COUNT,
      run: (): number => runMainLruReadBatches(MAIN_LRU_READ_BATCH_COUNT),
    });
    if (result.checksum !== operations) {
      throw new Error(`Main-thread LRU benchmark checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    resetIdentityStorageCache();
  }
}

async function flushMainWriteThrough(context: string): Promise<void> {
  const result: FlushResult = await flushDiskIODomain("whitelist", 120_000);
  if (result !== "flushed") {
    throw new Error(`${context} write-through flush ended as ${result}.`);
  }
  if (unacknowledgedWhitelistWrites.size !== 0) {
    throw new Error(
      `${context} left ${unacknowledgedWhitelistWrites.size} unacknowledged write(s).`
    );
  }
}

async function runMainWriteThroughChild(): Promise<ChildResult> {
  if (
    dirname(RUNTIME_DATA_ROOT) !== resolve(process.cwd()) ||
    !basename(RUNTIME_DATA_ROOT).startsWith(MAIN_BENCHMARK_ROOT_PREFIX)
  ) {
    throw new Error("Main-thread write-through benchmark requires its isolated temporary root.");
  }
  initDiskIO();
  try {
    const loaded: LoadedData = await loadPersistedData(120_000);
    hydrateIdentityStorageCounts(
      loaded.whitelistEntryCount,
      loaded.blocklistEntryCount
    );
    seedMainWriteThroughCache();
    const warmupOperations: number = MAIN_WRITE_THROUGH_WORKING_SET * 2;
    const warmupChecksum: number = runMainWriteThroughOperations(warmupOperations, 0);
    if (warmupChecksum !== warmupOperations) {
      throw new Error(`Main-thread write-through warmup checksum mismatch: ${warmupChecksum}.`);
    }
    await flushMainWriteThrough("Warmup");

    const result: ChildResult = await measuredResultAsync({
      operation: "main-write-through-acked",
      operations: MAIN_WRITE_THROUGH_OPERATION_COUNT,
      batches: MAIN_WRITE_THROUGH_OPERATION_COUNT / IDENTITY_WRITE_BATCH_MAX_ENTRIES,
      run: async (): Promise<number> => {
        const checksum: number = runMainWriteThroughOperations(
          MAIN_WRITE_THROUGH_OPERATION_COUNT,
          warmupOperations
        );
        await flushMainWriteThrough("Measured");
        return checksum;
      },
    });
    if (result.checksum !== MAIN_WRITE_THROUGH_OPERATION_COUNT) {
      throw new Error(`Main-thread write-through checksum mismatch: ${result.checksum}.`);
    }
    return result;
  } finally {
    await terminateDiskIO();
    resetIdentityStorageCache();
  }
}

function mean(values: readonly number[]): number {
  let sum: number = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function standardDeviation(values: readonly number[], average: number): number {
  let squaredDifferenceSum: number = 0;
  for (const value of values) {
    const difference: number = value - average;
    squaredDifferenceSum += difference * difference;
  }
  return Math.sqrt(squaredDifferenceSum / values.length);
}

function aggregate(results: readonly ChildResult[]): AggregateResult {
  const first: ChildResult = results[0]!;
  const throughputs: number[] = results.map(
    (result: ChildResult): number => result.throughputPerSecond
  );
  const averageThroughput: number = mean(throughputs);
  return {
    operation: first.operation,
    samples: results.length,
    operationsPerSample: first.operations,
    batchesPerSample: first.batches,
    averageThroughputPerSecond: averageThroughput,
    minThroughputPerSecond: Math.min(...throughputs),
    maxThroughputPerSecond: Math.max(...throughputs),
    coefficientOfVariationPercent:
      standardDeviation(throughputs, averageThroughput) * 100 / averageThroughput,
    averageBatchLatencyMs: mean(results.map(
      (result: ChildResult): number => result.meanBatchLatencyMs
    )),
    averageRetainedHeapDelta: mean(results.map(
      (result: ChildResult): number => result.retainedHeapDelta
    )),
    averageRetainedExtraMemoryDelta: mean(results.map(
      (result: ChildResult): number => result.retainedExtraMemoryDelta
    )),
    averageRetainedObjectDelta: mean(results.map(
      (result: ChildResult): number => result.retainedObjectDelta
    )),
    averageGcBeforeMs: mean(results.map(
      (result: ChildResult): number => result.gcBeforeMs
    )),
    averageGcAfterMs: mean(results.map(
      (result: ChildResult): number => result.gcAfterMs
    )),
    checksum: results.reduce(
      (sum: number, result: ChildResult): number => sum + result.checksum,
      0
    ),
  };
}

async function runOperation(operation: BenchmarkOperation): Promise<ChildResult> {
  if (operation === "storage-read") return runReadChild();
  if (operation === "storage-write") return runWriteChild();
  if (operation === "main-lru-read") return runMainLruReadChild();
  return runMainWriteThroughChild();
}

const BENCHMARK_OPERATIONS: readonly BenchmarkOperation[] = [
  "main-lru-read",
  "main-write-through-acked",
  "storage-read",
  "storage-write",
];

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
    storageReadBatchSize: READ_BATCH_SIZE,
    storageWriteTransactionSize: IDENTITY_WRITE_BATCH_MAX_ENTRIES,
    mainLruCapacity: IDENTITY_READ_CACHE_MAX_ENTRIES,
    mainWriteThroughWorkingSet: MAIN_WRITE_THROUGH_WORKING_SET,
    results: aggregates,
  };
}

function createMainBenchmarkRoot(): string {
  const temporaryRoot: string = mkdtempSync(
    join(process.cwd(), MAIN_BENCHMARK_ROOT_PREFIX)
  );
  try {
    const databaseDirectory: string = join(temporaryRoot, "database");
    mkdirSync(databaseDirectory);
    const path: string = join(databaseDirectory, "storage.sqlite");
    createIdentityDatabase(path);
    enableIdentityDatabaseWal(path);
    const database: IdentityDatabase = openIdentityDatabase({ path });
    try {
      seedIdentityDatabase(database, {
        metadata: [{
          key: IDENTITY_DATABASE_SCHEMA_KEY,
          data: IDENTITY_DATABASE_SCHEMA_DATA,
        }],
        whitelist: [],
        blocklist: [],
        removals: [],
      });
    } finally {
      closeIdentityDatabase(database);
    }
    return temporaryRoot;
  } catch (error: unknown) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertMainBenchmarkDatabase(temporaryRoot: string): void {
  const path: string = join(temporaryRoot, "database", "storage.sqlite");
  const database: IdentityDatabase = openIdentityDatabase({ path, readonly: true });
  try {
    assertIdentityDatabaseIntegrity(database);
    assertIdentityDatabaseJsonbStorage(database, path);
  } finally {
    closeIdentityDatabase(database);
  }
}

function mainBenchmarkEnvironment(
  temporaryRoot: string
): Readonly<Record<string, string | undefined>> {
  return {
    ...process.env,
    [RUNTIME_DATA_ROOT_ENV]: temporaryRoot,
    [CONFIG_ROOT_ENV]: join(process.cwd(), "config_example"),
  };
}

function runIndependentChild(operation: BenchmarkOperation): ChildResult {
  const temporaryRoot: string | null = operation === "main-write-through-acked"
    ? createMainBenchmarkRoot()
    : null;
  try {
    const child: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
      cmd: [process.execPath, import.meta.path, "--child", operation],
      stdout: "pipe",
      stderr: "inherit",
      ...(temporaryRoot === null
        ? {}
        : { env: mainBenchmarkEnvironment(temporaryRoot) }),
    });
    if (child.exitCode !== 0) {
      throw new Error(`Identity ${operation} benchmark child exited ${child.exitCode}.`);
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

function runParent(): BenchmarkReport {
  const aggregates: AggregateResult[] = [];
  for (const operation of BENCHMARK_OPERATIONS) {
    const results: ChildResult[] = [];
    for (
      let sample: number = 0;
      sample < INDEPENDENT_PROCESS_SAMPLE_COUNT;
      sample += 1
    ) {
      results.push(runIndependentChild(operation));
    }
    aggregates.push(aggregate(results));
  }
  return report(
    aggregates,
    "independent-processes",
    INDEPENDENT_PROCESS_SAMPLE_COUNT
  );
}

async function runSingleProcess(): Promise<BenchmarkReport> {
  const aggregates: AggregateResult[] = [];
  for (const operation of BENCHMARK_OPERATIONS) {
    const results: ChildResult[] = [];
    for (
      let sample: number = 0;
      sample < SINGLE_PROCESS_SAMPLE_COUNT;
      sample += 1
    ) {
      results.push(await runOperation(operation));
    }
    aggregates.push(aggregate(results));
  }
  return report(aggregates, "single-process", SINGLE_PROCESS_SAMPLE_COUNT);
}

function runSingleProcessParent(): BenchmarkReport {
  const temporaryRoot: string = createMainBenchmarkRoot();
  try {
    const child: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync({
      cmd: [process.execPath, import.meta.path, "--single-process-child"],
      stdout: "pipe",
      stderr: "inherit",
      env: mainBenchmarkEnvironment(temporaryRoot),
    });
    if (child.exitCode !== 0) {
      throw new Error(`Identity single-process benchmark child exited ${child.exitCode}.`);
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
  if (!BENCHMARK_OPERATIONS.includes(operation as BenchmarkOperation)) {
    throw new Error("Expected a supported identity benchmark operation.");
  }
  const result: ChildResult = await runOperation(operation as BenchmarkOperation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (Bun.argv[2] === "--single-process-child") {
  process.stdout.write(`${JSON.stringify(await runSingleProcess(), null, 2)}\n`);
} else if (Bun.argv[2] === "--single-process") {
  process.stdout.write(`${JSON.stringify(runSingleProcessParent(), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(runParent(), null, 2)}\n`);
}
