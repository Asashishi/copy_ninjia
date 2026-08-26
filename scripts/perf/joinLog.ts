/**
 * 入群日志 25 万容量线的独立进程对照基准。
 *
 * 父进程交替启动 baseline/current 子进程，确保每个样本有独立 JSC 堆与预热；
 * baseline 是固定参照算法：整表复制加排序加整串 JSON（snapshot/capacity），
 * 或按记录重新序列化一次只为量字节数（append-accounting）。
 */

import { snapshotHeap } from "./heapSnapshot";
import { median } from "./statistics";
import { DAY_FILE_JSON_INDENT } from "../../packages/consts/diskIO/appendOnly";
import {
  JOIN_LOG_ENTRY_SEPARATOR_BYTES,
  JOIN_LOG_MAX_BUFFERED_ENTRIES,
} from "../../packages/consts/diskIO/joinLog";
import {
  joinLogSnapshotChunks,
  joinLogSnapshotEntryBytes,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} from "../../packages/workers/diskIO/joinLogRecords";
import type { HeapSnapshot } from "./heapSnapshot";
import type { JoinLogRecord } from "../../packages/types/diskIO/storage";

type Operation = "snapshot" | "capacity" | "append-accounting";
type Variant = "baseline" | "current";

interface CapacityFixture {
  capacity: number;
  records: Map<number, JoinLogRecord>;
  incoming: readonly JoinLogRecord[];
}

/** 一次 flush 的记录批次，按批重复以达到与其它算子同量级的输入规模。 */
interface AppendFixture {
  batch: readonly JoinLogRecord[];
  batchCount: number;
}

interface ChildResult {
  operation: Operation;
  variant: Variant;
  bunVersion: string;
  bunRevision: string;
  recordCount: number;
  overflow: number;
  warmupRecordCount: number;
  elapsedMs: number;
  heapDeltaBeforeGc: number;
  extraMemoryDeltaBeforeGc: number;
  objectDeltaBeforeGc: number;
  retainedHeapDelta: number;
  retainedExtraMemoryDelta: number;
  retainedObjectDelta: number;
  checksum: number;
}

interface AggregateResult {
  operation: Operation;
  variant: Variant;
  samples: number;
  medianElapsedMs: number;
  minElapsedMs: number;
  maxElapsedMs: number;
  medianHeapDeltaBeforeGc: number;
  medianExtraMemoryDeltaBeforeGc: number;
  medianObjectDeltaBeforeGc: number;
  medianRetainedHeapDelta: number;
  medianRetainedExtraMemoryDelta: number;
  medianRetainedObjectDelta: number;
}

interface BenchmarkReport {
  bunVersion: string;
  bunRevision: string;
  recordCount: number;
  overflow: number;
  warmupRecordCount: number;
  independentProcessSamples: number;
  results: AggregateResult[];
}

/** 生产容量线；输入固定后 baseline/current 才能做同轮对照。 */
const RECORD_COUNT: number = 250_000;
/** 单次正常 flush 最多引入的高基数溢出量。 */
const OVERFLOW: number = 300;
/** 子进程正式采样前的小规模预热输入。 */
const WARMUP_RECORD_COUNT: number = 10_000;
/** 每个变体使用的独立进程样本数。 */
const PROCESS_SAMPLE_COUNT: number = 5;
/** 单批规模取生产的待刷上限，对应一次 flush 能携带的最大事实数。 */
const APPEND_BATCH_SIZE: number = JOIN_LOG_MAX_BUFFERED_ENTRIES;
/** 批次数使总输入与 snapshot/capacity 同在 25 万条量级。 */
const APPEND_BATCH_COUNT: number =
  Math.floor(RECORD_COUNT / APPEND_BATCH_SIZE);

function createRecords(count: number): Map<number, JoinLogRecord> {
  const records: Map<number, JoinLogRecord> = new Map();
  for (let userId: number = 1; userId <= count; userId += 1) {
    records.set(userId, {
      userId,
      joinedAt: 1_800_000_000_000 + userId,
    });
  }
  return records;
}

function createAppendFixture(): AppendFixture {
  const batch: JoinLogRecord[] = new Array<JoinLogRecord>(APPEND_BATCH_SIZE);
  for (let index: number = 0; index < APPEND_BATCH_SIZE; index += 1) {
    const userId: number = index + 1;
    batch[index] = { userId, joinedAt: 1_800_000_000_000 + userId };
  }
  return { batch, batchCount: APPEND_BATCH_COUNT };
}

function createCapacityFixture(
  capacity: number,
  overflow: number
): CapacityFixture {
  const records: Map<number, JoinLogRecord> = createRecords(capacity);
  const incoming: JoinLogRecord[] = new Array<JoinLogRecord>(overflow);
  for (let index: number = 0; index < overflow; index += 1) {
    const userId: number = capacity + index + 1;
    incoming[index] = {
      userId,
      joinedAt: 1_800_000_000_000 + userId,
    };
  }
  return { capacity, records, incoming };
}

/** 固定参照快照：values 数组 + 排序 + 投影对象 + 完整 JSON 字符串。 */
function baselineSnapshot(records: ReadonlyMap<number, JoinLogRecord>): number {
  const ordered: JoinLogRecord[] = [...records.values()];
  ordered.sort((
    left: JoinLogRecord,
    right: JoinLogRecord
  ): number => left.joinedAt - right.joinedAt || left.userId - right.userId);
  const snapshot: Record<string, JoinLogRecord> = {};
  for (const record of ordered) {
    snapshot[`${record.joinedAt}:${record.userId}`] = record;
  }
  return Buffer.byteLength(
    JSON.stringify(snapshot, null, DAY_FILE_JSON_INDENT)
  );
}

/** 当前快照：直接按生产分块迭代器流式消费；准确字节数由文件缓存增量维护。 */
function currentSnapshot(records: ReadonlyMap<number, JoinLogRecord>): number {
  let streamedBytes: number = 0;
  for (const chunk of joinLogSnapshotChunks(records)) {
    streamedBytes += Buffer.byteLength(chunk);
  }
  return streamedBytes;
}

/** 固定参照容量路径：复制整张 Map，再展开和排序全部 entry。 */
function baselineCapacity(fixture: CapacityFixture): number {
  const next: Map<number, JoinLogRecord> = new Map(fixture.records);
  for (const record of fixture.incoming) next.set(record.userId, record);
  const overflow: number = next.size - fixture.capacity;
  const ordered: [number, JoinLogRecord][] = [...next.entries()];
  ordered.sort((
    left: [number, JoinLogRecord],
    right: [number, JoinLogRecord]
  ): number =>
    left[1].joinedAt - right[1].joinedAt || left[0] - right[0]
  );
  for (let index: number = 0; index < overflow; index += 1) {
    next.delete(ordered[index]![0]);
  }
  return capacityChecksum(next, fixture.capacity);
}

/** 当前容量路径：直接更新可重建索引，只分配 overflow 个淘汰 id。 */
function currentCapacity(fixture: CapacityFixture): number {
  for (const record of fixture.incoming) {
    fixture.records.set(record.userId, record);
  }
  trimJoinLogRecordsToCapacity(fixture.records, fixture.capacity);
  return capacityChecksum(fixture.records, fixture.capacity);
}

/**
 * 固定参照记账：追加落盘后按记录再调用一次 joinLogSnapshotEntryBytes，而它
 * 内部会把同一条记录重新序列化一遍，只为量出它的字节数。
 */
function baselineAppendAccounting(fixture: AppendFixture): number {
  let bytes: number = 0;
  for (let batch: number = 0; batch < fixture.batchCount; batch += 1) {
    const texts: string[] = new Array<string>(fixture.batch.length);
    for (let index: number = 0; index < fixture.batch.length; index += 1) {
      texts[index] = serializeJoinLogSnapshotEntry(fixture.batch[index]!);
    }
    bytes += Buffer.byteLength(texts.join(",\n"));
    for (const record of fixture.batch) {
      bytes += JOIN_LOG_ENTRY_SEPARATOR_BYTES +
        joinLogSnapshotEntryBytes(record);
    }
  }
  return bytes;
}

/** 当前记账：复用同一轮已经序列化好的分段文本，整批只序列化一次。 */
function currentAppendAccounting(fixture: AppendFixture): number {
  let bytes: number = 0;
  for (let batch: number = 0; batch < fixture.batchCount; batch += 1) {
    const texts: string[] = new Array<string>(fixture.batch.length);
    for (let index: number = 0; index < fixture.batch.length; index += 1) {
      texts[index] = serializeJoinLogSnapshotEntry(fixture.batch[index]!);
    }
    bytes += Buffer.byteLength(texts.join(",\n"));
    for (const text of texts) {
      bytes += JOIN_LOG_ENTRY_SEPARATOR_BYTES + Buffer.byteLength(text);
    }
  }
  return bytes;
}

function capacityChecksum(
  records: ReadonlyMap<number, JoinLogRecord>,
  capacity: number
): number {
  return records.size +
    (records.has(1) ? 1 : 0) +
    (records.has(OVERFLOW) ? 2 : 0) +
    (records.has(OVERFLOW + 1) ? 4 : 0) +
    (records.has(capacity + OVERFLOW) ? 8 : 0);
}

function warmUp(operation: Operation, variant: Variant): void {
  for (let iteration: number = 0; iteration < 3; iteration += 1) {
    if (operation === "snapshot") {
      const records: Map<number, JoinLogRecord> =
        createRecords(WARMUP_RECORD_COUNT);
      if (variant === "baseline") baselineSnapshot(records);
      else currentSnapshot(records);
      continue;
    }
    if (operation === "append-accounting") {
      const warmup: AppendFixture = { batch: createAppendFixture().batch, batchCount: 3 };
      if (variant === "baseline") baselineAppendAccounting(warmup);
      else currentAppendAccounting(warmup);
      continue;
    }
    const fixture: CapacityFixture =
      createCapacityFixture(WARMUP_RECORD_COUNT, OVERFLOW);
    if (variant === "baseline") baselineCapacity(fixture);
    else currentCapacity(fixture);
  }
}

function runChild(operation: Operation, variant: Variant): ChildResult {
  warmUp(operation, variant);
  let input: Map<number, JoinLogRecord> | CapacityFixture | AppendFixture;
  if (operation === "snapshot") input = createRecords(RECORD_COUNT);
  else if (operation === "append-accounting") input = createAppendFixture();
  else input = createCapacityFixture(RECORD_COUNT, OVERFLOW);
  Bun.gc(true);
  const before: HeapSnapshot = snapshotHeap();
  const startedAt: number = performance.now();
  let checksum: number;
  if (operation === "snapshot") {
    checksum = variant === "baseline"
      ? baselineSnapshot(input as Map<number, JoinLogRecord>)
      : currentSnapshot(input as Map<number, JoinLogRecord>);
  } else if (operation === "append-accounting") {
    checksum = variant === "baseline"
      ? baselineAppendAccounting(input as AppendFixture)
      : currentAppendAccounting(input as AppendFixture);
  } else {
    checksum = variant === "baseline"
      ? baselineCapacity(input as CapacityFixture)
      : currentCapacity(input as CapacityFixture);
  }
  const elapsedMs: number = performance.now() - startedAt;
  const beforeGc: HeapSnapshot = snapshotHeap();
  Bun.gc(true);
  const retained: HeapSnapshot = snapshotHeap();
  return {
    operation,
    variant,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    recordCount: RECORD_COUNT,
    overflow: OVERFLOW,
    warmupRecordCount: WARMUP_RECORD_COUNT,
    elapsedMs,
    heapDeltaBeforeGc: beforeGc.heapSize - before.heapSize,
    extraMemoryDeltaBeforeGc:
      beforeGc.extraMemorySize - before.extraMemorySize,
    objectDeltaBeforeGc: beforeGc.objectCount - before.objectCount,
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    checksum,
  };
}

function aggregate(results: readonly ChildResult[]): AggregateResult {
  const first: ChildResult = results[0]!;
  const elapsed: number[] = results.map(
    (result: ChildResult): number => result.elapsedMs
  );
  return {
    operation: first.operation,
    variant: first.variant,
    samples: results.length,
    medianElapsedMs: median(elapsed),
    minElapsedMs: Math.min(...elapsed),
    maxElapsedMs: Math.max(...elapsed),
    medianHeapDeltaBeforeGc: median(results.map(
      (result: ChildResult): number => result.heapDeltaBeforeGc
    )),
    medianExtraMemoryDeltaBeforeGc: median(results.map(
      (result: ChildResult): number => result.extraMemoryDeltaBeforeGc
    )),
    medianObjectDeltaBeforeGc: median(results.map(
      (result: ChildResult): number => result.objectDeltaBeforeGc
    )),
    medianRetainedHeapDelta: median(results.map(
      (result: ChildResult): number => result.retainedHeapDelta
    )),
    medianRetainedExtraMemoryDelta: median(results.map(
      (result: ChildResult): number => result.retainedExtraMemoryDelta
    )),
    medianRetainedObjectDelta: median(results.map(
      (result: ChildResult): number => result.retainedObjectDelta
    )),
  };
}

function parseOperation(value: string | undefined): Operation {
  if (
    value === "snapshot" ||
    value === "capacity" ||
    value === "append-accounting"
  ) {
    return value;
  }
  throw new Error(
    "Child operation must be snapshot, capacity or append-accounting."
  );
}

function parseVariant(value: string | undefined): Variant {
  if (value === "baseline" || value === "current") return value;
  throw new Error("Child variant must be baseline or current.");
}

function runIndependentChild(
  operation: Operation,
  variant: Variant
): ChildResult {
  const result: Bun.ReadableSyncSubprocess = Bun.spawnSync([
    process.execPath,
    import.meta.path,
    "--child",
    operation,
    variant,
  ]);
  if (!result.success) {
    throw new Error(
      `Join log benchmark child failed: ${result.stderr.toString()}`
    );
  }
  return JSON.parse(result.stdout.toString()) as ChildResult;
}

function runParent(): BenchmarkReport {
  const grouped: Map<string, ChildResult[]> = new Map();
  const operations: readonly Operation[] = [
    "snapshot",
    "capacity",
    "append-accounting",
  ];
  const variants: readonly Variant[] = ["baseline", "current"];
  for (let sample: number = 0; sample < PROCESS_SAMPLE_COUNT; sample += 1) {
    for (const operation of operations) {
      for (const variant of variants) {
        const result: ChildResult =
          runIndependentChild(operation, variant);
        if (
          result.bunVersion !== Bun.version ||
          result.bunRevision !== Bun.revision
        ) {
          throw new Error("All benchmark samples must use the same Bun build.");
        }
        const key: string = `${operation}:${variant}`;
        const values: ChildResult[] = grouped.get(key) ?? [];
        values.push(result);
        grouped.set(key, values);
      }
    }
  }
  for (const operation of operations) {
    const baseline: ChildResult[] = grouped.get(`${operation}:baseline`)!;
    const current: ChildResult[] = grouped.get(`${operation}:current`)!;
    for (let index: number = 0; index < baseline.length; index += 1) {
      if (baseline[index]!.checksum !== current[index]!.checksum) {
        throw new Error(`${operation} variants produced different checksums.`);
      }
    }
  }
  const results: AggregateResult[] = [];
  for (const operation of operations) {
    for (const variant of variants) {
      results.push(aggregate(grouped.get(`${operation}:${variant}`)!));
    }
  }
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    recordCount: RECORD_COUNT,
    overflow: OVERFLOW,
    warmupRecordCount: WARMUP_RECORD_COUNT,
    independentProcessSamples: PROCESS_SAMPLE_COUNT,
    results,
  };
}

if (Bun.argv[2] === "--child") {
  const result: ChildResult = runChild(
    parseOperation(Bun.argv[3]),
    parseVariant(Bun.argv[4])
  );
  await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
} else {
  const report: BenchmarkReport = runParent();
  await Bun.write(Bun.stdout, `${JSON.stringify(report, null, 2)}\n`);
}
