import { snapshotHeap } from "../heapSnapshot";
import { mean, standardDeviation } from "../statistics";
import type { HeapSnapshot } from "../heapSnapshot";
import type {
  AggregateResult,
  BenchmarkOperation,
  ChildResult,
} from "./types";

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

function forceGc(): number {
  const startedAt: number = performance.now();
  Bun.gc(true);
  return performance.now() - startedAt;
}

export function measuredResult({
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

export async function measuredResultAsync({
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

export function aggregate(results: readonly ChildResult[]): AggregateResult {
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
