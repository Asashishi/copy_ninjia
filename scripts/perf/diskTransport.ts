/** 主线程业务通道 mock：计量队列和确认开销、延迟、堆及停滞上限，不含 Worker clone 与磁盘等待。 */
import { DISK_BUSINESS_BATCH_MAX_MESSAGES } from "../../packages/consts/diskIO/business";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES } from "../../packages/consts/diskIO/common";
import type { DiskIOMessage, DiskOperationBatchRequest, TemporaryWhitelistWriteDiskMessage } from "../../packages/types/diskIO/messages";
import type * as Runtime from "../../packages/cache/main/diskIO";
import type * as DiskIO from "../../packages/infra/diskIO";
import type * as Transport from "../../packages/infra/diskIO/transport";
import type * as Jsc from "bun:jsc";
import type * as Profile from "./hotPaths/profileSummary";

if (Bun.argv[2] !== "--child") {
  for (let round: number = 0; round < 3; round++) {
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn([Bun.argv[0]!, import.meta.path, "--child"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const output: Promise<string> = child.stdout.text();
    const errors: Promise<string> = child.stderr.text();
    const exitCode: number = await child.exited;
    const stdout: string = await output;
    const stderr: string = await errors;
    if (exitCode !== 0) throw new Error(stderr);
    console.log(JSON.stringify({ round, result: JSON.parse(stdout) as unknown }));
  }
} else {
  const { diskIORuntime }: typeof Runtime = await import("../../packages/cache/main/diskIO");
  const { postDiskIO }: typeof DiskIO = await import("../../packages/infra/diskIO");
  const { acceptDiskIOOperationBatch, resetDiskIOOperations }: typeof Transport = await import("../../packages/infra/diskIO/transport");
  const { heapStats, profile, numberOfDFGCompiles: JscProbe, reoptimizationRetryCount: reoptimizationProbe }: typeof Jsc = await import("bun:jsc");
  const { summarizeHotPathSamplingProfile }: typeof Profile = await import("./hotPaths/profileSummary");
  const total: number = DEFAULT_MAX_PENDING_BUSINESS_MESSAGES * 2;
  const timestamps: Float64Array = new Float64Array(total);
  const latency: Float64Array = new Float64Array(total);
  let nextConsumed: number = 0;
  let pendingBatch: DiskOperationBatchRequest | null = null;
  let fatalCount: number = 0;
  const fake: Worker = {
    postMessage: (message: DiskIOMessage): void => {
      if (message.type !== "operationBatch" || pendingBatch !== null) throw new Error("Invalid business delivery window.");
      pendingBatch = message;
    },
  } as unknown as Worker;
  const message: TemporaryWhitelistWriteDiskMessage = { type: "temporaryWhitelistWrite", id: 1, activity: null, revision: 1 };
  function reset(): void {
    resetDiskIOOperations(); pendingBatch = null; nextConsumed = 0;
    diskIORuntime.worker = fake; diskIORuntime.writable = true;
    diskIORuntime.fatalSignaled = false;
    diskIORuntime.fatalHandler = (): void => { fatalCount++; };
  }
  function consume(measure: boolean): void {
    while (pendingBatch !== null) {
      const batch: DiskOperationBatchRequest = pendingBatch;
      pendingBatch = null;
      if (measure) {
        for (const _message of batch.messages) {
          latency[nextConsumed] = Bun.nanoseconds() - timestamps[nextConsumed]!;
          nextConsumed++;
        }
      }
      acceptDiskIOOperationBatch(fake, batch.batchId);
    }
  }
  function normal(count: number): number {
    reset();
    const started: number = Bun.nanoseconds();
    for (let index: number = 0; index < count; index++) {
      timestamps[index] = Bun.nanoseconds();
      if (!postDiskIO(message)) throw new Error("Healthy business queue rejected an input.");
      if ((index + 1) % DISK_BUSINESS_BATCH_MAX_MESSAGES === 0) consume(true);
    }
    consume(true);
    if (nextConsumed !== count || diskIORuntime.operationQueue.size !== 0) throw new Error("Business queue did not drain.");
    return (Bun.nanoseconds() - started) / count;
  }
  normal(total);
  normal(total);
  const samples: number[] = [];
  let peakRss: number = 0;
  let peakHeap: number = 0;
  for (let sample: number = 0; sample < 7; sample++) {
    samples.push(normal(total));
    const memory: ReturnType<typeof process.memoryUsage> = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }
  latency.sort(); samples.sort((left: number, right: number): number => left - right);
  const p95: number = latency[Math.floor(total * 0.95)]!;
  const p99: number = latency[Math.floor(total * 0.99)]!;
  const sampling: Profile.HotPathSamplingProfileSummary = summarizeHotPathSamplingProfile(profile((): void => { normal(total); }, 100));
  reset(); Bun.gc(true);
  const baselineHeap: number = heapStats().heapSize;
  let accepted: number = 0;
  for (let index: number = 0; index < total; index++) if (postDiskIO(message)) accepted++;
  Bun.gc(true);
  const stalledHeap: number = heapStats().heapSize;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (accepted !== DEFAULT_MAX_PENDING_BUSINESS_MESSAGES || fatalCount !== 1) throw new Error("Stalled queue violated admission capacity.");
  const retainedCount: number = diskIORuntime.operationQueue.size;
  consume(false); resetDiskIOOperations(); Bun.gc(true);
  const drainedHeap: number = heapStats().heapSize;
  console.log(JSON.stringify({ bunVersion: Bun.version, bunRevision: Bun.revision, total, batch: DISK_BUSINESS_BATCH_MAX_MESSAGES,
    samplesNsPerMessage: samples, medianNsPerMessage: samples[3], messagesPerSecond: 1_000_000_000 / samples[3]!,
    p95ConsumptionNs: p95, p99ConsumptionNs: p99,
    accepted, retainedCount, fatalCount, retainedStalledBytes: stalledHeap - baselineHeap, retainedAfterDrainBytes: drainedHeap - baselineHeap,
    peakSampledRssBytes: peakRss, peakSampledHeapBytes: peakHeap,
    gcPercent: sampling.gcPercent, profileSamples: sampling.totalSamples,
    jit: { dfgCompiles: JscProbe(postDiskIO), reoptRetries: reoptimizationProbe(postDiskIO) } }));
  diskIORuntime.worker = null; diskIORuntime.writable = false; diskIORuntime.fatalHandler = undefined; diskIORuntime.fatalSignaled = false;
}
