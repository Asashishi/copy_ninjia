/** 真实 Disk I/O Worker 的批量入队、事务 ACK 与重建恢复；只允许隔离基准数据根。 */
import { heapStats } from "bun:jsc";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { DISK_BUSINESS_BATCH_MAX_MESSAGES } from "../../../packages/consts/diskIO/business";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import { validateExistingDeploymentInputs } from "../../../packages/config/readiness";
import { unacknowledgedChatStateWrites } from "../../../packages/cache/main/chatState";
import { diskIORuntime } from "../../../packages/cache/main/diskIO";
import { flushDiskIODomain, initDiskIO, loadPersistedData, terminateDiskIO } from "../../../packages/infra/diskIO";
import { hydrateChatStateCache, queueChatStateWrite } from "../../../packages/infra/chatStateStorage";
import { getOrCreateChatState } from "../../../packages/infra/storage/stateStore";
import { CHAIN_CHAT_STATE_WRITES, CHAIN_WARMUP_OPERATIONS } from "../fullSuite/constants";
import { benchmarkChatId } from "../fullSuite/fixture";
import { assertBenchmarkRuntimeRoot } from "../fullSuite/mockRoot";
import { installOutboundGuards } from "../outboundGuard";
import { percentile } from "../statistics";
import type { ChatState } from "../../../packages/types/chatState";
import type { LoadedData } from "../../../packages/types/diskIO/replies";

async function burst(sequence: number): Promise<void> {
  for (let index: number = 0; index < DISK_BUSINESS_BATCH_MAX_MESSAGES; index++) {
    const chatId: number = benchmarkChatId(index % STATE_MANAGED_CHAT_LIMIT);
    const state: ChatState = getOrCreateChatState(chatId);
    state.title = `Pressure ${sequence}:${index}`;
    queueChatStateWrite(chatId);
  }
  if (await flushDiskIODomain("chatState") !== "flushed" || unacknowledgedChatStateWrites.size !== 0 || diskIORuntime.pendingBusinessMessages.size !== 0) {
    throw new Error("Disk pressure burst did not receive every final revision ACK.");
  }
}

function verifyRecovered(data: LoadedData, sequence: number): void {
  if (data.chatStates.size !== STATE_MANAGED_CHAT_LIMIT) throw new Error("Disk pressure recovery lost chats.");
  for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index++) {
    const finalIndex: number = index + Math.floor((DISK_BUSINESS_BATCH_MAX_MESSAGES - 1 - index) / STATE_MANAGED_CHAT_LIMIT) * STATE_MANAGED_CHAT_LIMIT;
    if (data.chatStates.get(benchmarkChatId(index))?.title !== `Pressure ${sequence}:${finalIndex}`) throw new Error("Disk pressure recovery lost a final revision.");
  }
}

assertBenchmarkRuntimeRoot(RUNTIME_DATA_ROOT);
installOutboundGuards();
console.log = console.error;
console.info = console.error;
console.warn = console.error;
await validateExistingDeploymentInputs();
initDiskIO();
try {
  hydrateChatStateCache((await loadPersistedData()).chatStates);
  for (let index: number = 0; index < CHAIN_WARMUP_OPERATIONS; index++) await burst(index);
  Bun.gc(true);
  const before: ReturnType<typeof heapStats> = heapStats();
  const latencies: number[] = [];
  let peakHeap: number = before.heapSize;
  let peakRss: number = process.memoryUsage().rss;
  const startedAt: number = Bun.nanoseconds();
  for (let index: number = 0; index < CHAIN_CHAT_STATE_WRITES; index++) {
    const start: number = Bun.nanoseconds();
    await burst(CHAIN_WARMUP_OPERATIONS + index);
    latencies.push((Bun.nanoseconds() - start) / 1_000_000);
    const memory: NodeJS.MemoryUsage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  }
  const elapsedMs: number = (Bun.nanoseconds() - startedAt) / 1_000_000;
  Bun.gc(true);
  const after: ReturnType<typeof heapStats> = heapStats();
  await terminateDiskIO();
  initDiskIO();
  const recovered: LoadedData = await loadPersistedData();
  verifyRecovered(recovered, CHAIN_WARMUP_OPERATIONS + CHAIN_CHAT_STATE_WRITES - 1);
  hydrateChatStateCache(recovered.chatStates);
  await burst(CHAIN_WARMUP_OPERATIONS + CHAIN_CHAT_STATE_WRITES);
  await terminateDiskIO();
  initDiskIO();
  verifyRecovered(await loadPersistedData(), CHAIN_WARMUP_OPERATIONS + CHAIN_CHAT_STATE_WRITES);
  latencies.sort((left: number, right: number): number => left - right);
  await Bun.write(Bun.stdout, `${JSON.stringify({
    bunVersion: Bun.version, bunRevision: Bun.revision,
    bursts: CHAIN_CHAT_STATE_WRITES, messagesPerBurst: DISK_BUSINESS_BATCH_MAX_MESSAGES,
    messages: CHAIN_CHAT_STATE_WRITES * DISK_BUSINESS_BATCH_MAX_MESSAGES,
    elapsedMs, messagesPerSecond: CHAIN_CHAT_STATE_WRITES * DISK_BUSINESS_BATCH_MAX_MESSAGES * 1_000 / elapsedMs,
    p50LatencyMs: percentile(latencies, 50), p95LatencyMs: percentile(latencies, 95),
    peakHeapBytes: peakHeap, peakRssBytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1_024),
    retainedHeapDelta: after.heapSize - before.heapSize,
    retainedObjectDelta: after.objectCount - before.objectCount,
    rebuiltWorkers: 2, recoveredChats: STATE_MANAGED_CHAT_LIMIT,
  })}\n`);
} finally {
  await terminateDiskIO();
}
