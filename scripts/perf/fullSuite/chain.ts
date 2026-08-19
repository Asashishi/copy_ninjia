/**
 * 链路子进程：逐次量「主线程发起 -> Disk I/O Worker -> 落盘 durable -> 回执」
 * 的端到端耗时。
 *
 * 与热路径分区的分工要说清楚：那边量的是纯 CPU 叶子和编排主干，这里量的是
 * **一条业务事实真正写进硬盘要多久**——包含 Worker 消息往返、SQLite 事务、
 * 追加写与 fsync。两组数不可互相换算，也不该放进同一张表比较。
 *
 * 五条链路各起一个子进程：同一个进程里连着跑，前一条链路留下的页缓存温度、
 * Worker 侧文件句柄和 JIT 反馈都会带进下一条，读数会系统性偏乐观。
 */

import { installOutboundGuards } from "../outboundGuard";
import {
  CHAIN_AI_MEMORY_SNAPSHOTS,
  CHAIN_CHAT_STATE_WRITES,
  CHAIN_IDENTITY_BATCHES,
  CHAIN_JOIN_LOG_EVENTS,
  CHAIN_LOG_ENTRIES,
  CHAIN_WARMUP_OPERATIONS,
} from "./constants";
import {
  benchmarkChatId,
  benchmarkUserId,
  buildAiMemorySnapshot,
} from "./fixture";
import { assertBenchmarkRuntimeRoot } from "./mockRoot";
import { percentile } from "../statistics";
import { diffProcessIo, readProcessIo } from "./processIo";
import { MAIN_WRITE_THROUGH_WORKING_SET } from "../identityDatabase/constants";
import { WHITE_ENTRY } from "../identityDatabase/fixtures";
import {
  blocklistEntryCache,
  whitelistEntryCache,
} from "../../../packages/cache/main/identityStorage";
import { IDENTITY_WRITE_BATCH_MAX_ENTRIES } from
  "../../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { RUNTIME_DATA_ROOT } from "../../../packages/consts/paths";
import {
  flushDiskIO,
  flushDiskIODomain,
  initDiskIO,
  loadPersistedData,
  postDiskIO,
  relayLogMessage,
  terminateDiskIO,
} from "../../../packages/infra/diskIO";
import { hydrateIdentityStorageCounts, queueIdentityPolicyWrite } from
  "../../../packages/infra/identityStorage";
import { persistChatState } from "../../../packages/infra/chatStateStorage";
import { recordJoinLog } from "../../../packages/infra/joinLog";
import { getOrCreateChatState } from
  "../../../packages/infra/storage/stateStore";
import type { ChatState } from "../../../packages/types/chatState";
import type { ProcessIoSnapshot } from "./processIo";
import type { ChainName, ChainRound } from "./types";

/** 一条链路的定义；`run` 必须在这一次 durable 完成后才返回。 */
interface ChainDefinition {
  readonly chain: ChainName;
  readonly operations: number;
  readonly recordsPerOperation: number;
  /** 正式计时前的一次性准备（灌缓存、建群状态等），不计时。 */
  readonly prepare?: () => void;
  readonly run: (sequence: number) => Promise<void>;
}

function chatIdForSequence(sequence: number): number {
  return benchmarkChatId(sequence % STATE_MANAGED_CHAT_LIMIT);
}

function joinLogChain(): ChainDefinition {
  return {
    chain: "join-log-append",
    operations: CHAIN_JOIN_LOG_EVENTS,
    recordsPerOperation: 1,
    // 不复用 fixture 的 joinLogEvent：那一份连东京日期一起算好，而
    // `recordJoinLog` 内部还会再算一次，等于在计时窗口里白付一次
    // `new Date` 加日期格式化。这里只给生产入口真正需要的三个字段。
    run: async (sequence: number): Promise<void> => {
      if (!await recordJoinLog({
        chatId: benchmarkChatId(sequence % STATE_MANAGED_CHAT_LIMIT),
        userId: benchmarkUserId(sequence),
        joinedAt: Date.now(),
      })) {
        throw new Error(`Join-log event ${sequence} did not reach the disk.`);
      }
    },
  };
}

function identityPolicyChain(): ChainDefinition {
  return {
    chain: "identity-policy-write",
    operations: CHAIN_IDENTITY_BATCHES,
    recordsPerOperation: IDENTITY_WRITE_BATCH_MAX_ENTRIES,
    // 写透要求主键的正负结论都已预热；生产里那是 update 前置预热做的事，
    // 基准在计时外一次性灌满同一批主键。
    prepare: (): void => {
      hydrateIdentityStorageCounts(0, 0);
      for (let id: number = 1; id <= MAIN_WRITE_THROUGH_WORKING_SET; id += 1) {
        whitelistEntryCache.set(id, null);
        blocklistEntryCache.set(id, null);
      }
    },
    run: async (sequence: number): Promise<void> => {
      const firstOperation: number = sequence * IDENTITY_WRITE_BATCH_MAX_ENTRIES;
      for (
        let offset: number = 0;
        offset < IDENTITY_WRITE_BATCH_MAX_ENTRIES;
        offset += 1
      ) {
        const operation: number = firstOperation + offset;
        const id: number = operation % MAIN_WRITE_THROUGH_WORKING_SET + 1;
        const cycle: number = Math.floor(operation / MAIN_WRITE_THROUGH_WORKING_SET);
        if (!queueIdentityPolicyWrite(
          "whitelist",
          id,
          (cycle & 1) === 0 ? WHITE_ENTRY : null
        )) {
          throw new Error(`Identity write ${operation} was rejected before reaching the Worker.`);
        }
      }
      if (await flushDiskIODomain("whitelist") !== "flushed") {
        throw new Error(`Identity write batch ${sequence} was not committed.`);
      }
    },
  };
}

function chatStateChain(): ChainDefinition {
  return {
    chain: "chat-state-write",
    operations: CHAIN_CHAT_STATE_WRITES,
    recordsPerOperation: 1,
    prepare: (): void => {
      for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
        getOrCreateChatState(benchmarkChatId(index));
      }
    },
    run: async (sequence: number): Promise<void> => {
      const chatId: number = chatIdForSequence(sequence);
      const state: ChatState = getOrCreateChatState(chatId);
      // 每次都要真的改一个字段：值没变时编码结果一样，量到的就不是一次真实
      // 状态变更的落盘成本。
      state.isAntiRaidEnabled = (sequence & 1) === 0;
      state.title = `Performance fixture chat ${sequence}`;
      await persistChatState(chatId, "performance benchmark chain");
    },
  };
}

function aiMemoryChain(): ChainDefinition {
  return {
    chain: "ai-memory-snapshot",
    operations: CHAIN_AI_MEMORY_SNAPSHOTS,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      const chatIndex: number = sequence % STATE_MANAGED_CHAT_LIMIT;
      if (!postDiskIO({
        type: "aiMemory",
        chatId: benchmarkChatId(chatIndex),
        revision: sequence + 1,
        snapshot: buildAiMemorySnapshot(chatIndex),
      })) {
        throw new Error(`AI memory snapshot ${sequence} was rejected before reaching the Worker.`);
      }
      if (await flushDiskIODomain("aiMemory") !== "flushed") {
        throw new Error(`AI memory snapshot ${sequence} was not written.`);
      }
    },
  };
}

function diagnosticLogChain(): ChainDefinition {
  return {
    chain: "diagnostic-log",
    operations: CHAIN_LOG_ENTRIES,
    recordsPerOperation: 1,
    run: async (sequence: number): Promise<void> => {
      if (!relayLogMessage({
        timestamp: Date.now(),
        level: "error",
        args: [
          `Performance benchmark diagnostic ${sequence} for chat`,
          benchmarkChatId(sequence % STATE_MANAGED_CHAT_LIMIT),
          benchmarkUserId(sequence),
        ],
      })) {
        throw new Error(`Diagnostic log ${sequence} was refused by the bounded channel.`);
      }
      // 诊断通道只有整轮 flush 会排空（见 infra/diskIO.ts 的 flushDiskIO），
      // 单领域 flush 不等诊断队列，用它量到的会是一条没写完就返回的假链路。
      if (await flushDiskIO() !== "flushed") {
        throw new Error(`Diagnostic log ${sequence} was not written.`);
      }
    },
  };
}

function createChain(chain: ChainName): ChainDefinition {
  switch (chain) {
    case "join-log-append":
      return joinLogChain();
    case "identity-policy-write":
      return identityPolicyChain();
    case "chat-state-write":
      return chatStateChain();
    case "ai-memory-snapshot":
      return aiMemoryChain();
    case "diagnostic-log":
      return diagnosticLogChain();
  }
}

/** 命令行参数到链路名的严格解析；未知值直接失败，不落到某个默认链路。 */
function parseChainName(value: string | undefined): ChainName {
  switch (value) {
    case "join-log-append":
    case "identity-policy-write":
    case "chat-state-write":
    case "ai-memory-snapshot":
    case "diagnostic-log":
      return value;
    default:
      throw new Error(
        "Chain child expects one of join-log-append|identity-policy-write|" +
        "chat-state-write|ai-memory-snapshot|diagnostic-log."
      );
  }
}

async function measureChain(definition: ChainDefinition): Promise<ChainRound> {
  definition.prepare?.();
  for (let index: number = 0; index < CHAIN_WARMUP_OPERATIONS; index += 1) {
    await definition.run(index);
  }
  const ioBefore: ProcessIoSnapshot = readProcessIo();
  const latenciesMs: number[] = new Array<number>(definition.operations);
  let peakRssBytes: number = process.memoryUsage().rss;
  const startedAtNs: number = Bun.nanoseconds();
  for (let index: number = 0; index < definition.operations; index += 1) {
    const operationStartedAtNs: number = Bun.nanoseconds();
    await definition.run(CHAIN_WARMUP_OPERATIONS + index);
    latenciesMs[index] = (Bun.nanoseconds() - operationStartedAtNs) / 1_000_000;
  }
  const elapsedMs: number = (Bun.nanoseconds() - startedAtNs) / 1_000_000;
  const io: ProcessIoSnapshot = readProcessIo();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const sorted: number[] = [...latenciesMs].sort(
    (left: number, right: number): number => left - right
  );
  let latencySum: number = 0;
  for (const latency of latenciesMs) latencySum += latency;
  const records: number = definition.operations * definition.recordsPerOperation;
  return {
    chain: definition.chain,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    operations: definition.operations,
    recordsPerOperation: definition.recordsPerOperation,
    elapsedMs,
    throughputPerSecond: records * 1_000 / elapsedMs,
    meanLatencyMs: latencySum / definition.operations,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    p99LatencyMs: percentile(sorted, 99),
    maxLatencyMs: sorted[sorted.length - 1]!,
    io: diffProcessIo(ioBefore, io),
    peakRssBytes: Math.max(
      peakRssBytes,
      process.resourceUsage().maxRSS * 1_024
    ),
    checksum: records,
  };
}

/** 在本进程的 mock 数据根上跑一条链路；Worker 由本函数拉起并负责终止。 */
async function runChainChild(chain: ChainName): Promise<ChainRound> {
  assertBenchmarkRuntimeRoot(RUNTIME_DATA_ROOT);
  installOutboundGuards();
  initDiskIO();
  try {
    await loadPersistedData();
    return await measureChain(createChain(chain));
  } finally {
    await terminateDiskIO();
  }
}

/** `--child chain <name>` 的入口；结果按 JSON 打到 stdout。 */
export async function main(argument: string | undefined): Promise<void> {
  const round: ChainRound = await runChainChild(parseChainName(argument));
  process.stdout.write(`${JSON.stringify(round)}\n`);
}
