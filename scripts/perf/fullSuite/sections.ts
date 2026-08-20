/**
 * 各分区的父进程编排：建根、播种、按轮 spawn 子进程、聚合成分区。
 *
 * 本文件属于父进程，因此**只 import 常量和类型**，不 import 任何会拉起生产
 * 模块图的实现（理由见 fullSuite/mockRoot.ts 的模块头注）。
 */

import { join } from "node:path";
import { aggregateMetric, aggregateRounds } from "./aggregate";
import { spawnJsonChild } from "./child";
import {
  PROJECT_ROOT,
  createRuntimeRoot,
  removeMockPath,
} from "./mockRoot";
import { measureDirectoryFootprint } from "./processIo";
import { STORAGE_OPERATIONS } from "./storageOperations";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../../packages/consts/environment";
import type { MetricDefinition } from "./aggregate";
import type { DirectoryFootprint } from "./processIo";
import type { ScenarioName } from "../hotPaths/types";
import type {
  BenchmarkEntry,
  BenchmarkSection,
  ChainName,
  ChainRound,
  ColdStartRound,
  ColdStartSummary,
  HotPathRound,
  ProcessIoDelta,
  StorageRound,
} from "./types";

/** 本次运行的共享上下文；各分区都往同一份读写与操作数账上记。 */
export interface SectionContext {
  readonly runRoot: string;
  readonly rounds: number;
  /** 进度只写 stderr：stdout 是给管道用的纯 JSON 报告。 */
  readonly onProgress: (message: string) => void;
  readonly recordIo: (io: ProcessIoDelta) => void;
  /** 记入一轮里完成的被测操作数（不是子进程数）。 */
  readonly recordOperations: (operations: number) => void;
  /** 记入一个运行时数据根被删除前的落盘足迹；报告把一轮里的各份相加。 */
  readonly recordFootprint: (footprint: DirectoryFootprint) => void;
}

/** 播种模式；`none` 表示这项测量不需要运行时数据根里有任何东西。 */
type SeedMode = "cold-start" | "chain" | "none";

const SUITE_ENTRY: string = join(PROJECT_ROOT, "scripts", "perf", "fullSuite.ts");
const HOT_PATH_ENTRY: string = join(PROJECT_ROOT, "scripts", "perf", "hotPaths.ts");
const JOIN_LOG_ENTRY: string = join(PROJECT_ROOT, "scripts", "perf", "joinLog.ts");

/**
 * 所有子进程统一读 `config_example/`。
 *
 * 不读部署方的 `config/`：那份可能带着真实 token 和各机器不同的开关，既让读数
 * 不可跨机比较，也没有任何理由让一次基准把生产凭据加载进来。
 */
const CONFIG_ROOT: string = join(PROJECT_ROOT, "config_example");

function childEnv(runtimeRoot: string): Readonly<Record<string, string>> {
  return {
    [RUNTIME_DATA_ROOT_ENV]: runtimeRoot,
    [CONFIG_ROOT_ENV]: CONFIG_ROOT,
  };
}

/** 生产热路径：真实业务函数，读数直接反映线上每条消息的成本。 */
export const PRODUCTION_HOT_PATH_SCENARIOS: readonly ScenarioName[] = [
  "incoming-message-spine",
  "ai-media-direct-trigger",
  "sender-no-username",
  "sender-stable-username",
  "self-sent-empty",
  "chat-state-read",
  "chat-state-map-read",
  "ai-activity-window",
  "ai-activity-lru-miss",
  "identity-permission-read",
  "flood-window-hit",
  "flood-window-growth",
  "flood-window-steady",
  "ad-empty-metadata",
  "ad-wire-clone",
  "ad-capacity-reject",
  "buffered-message-build",
  "transcript-render",
  "reply-reference",
  "mention-facts",
  "mention-facts-plain",
  "gag-speak-counter",
  "luck-receipt-fast-path",
  "luck-tier-table",
  "redact-clean-log",
];

/**
 * 生产选用的容器与算法，单独把容器本身的成本量出来。
 *
 * 只列线上真正在用的那一个实现：滑动窗口是 `LinkedQueue` + `trimSlidingWindow`，
 * AI 滚动记忆缓冲是 `BoundedDeque`。被淘汰的候选实现不进表——读者没有办法从
 * 一行读数看出它到底是不是生产成本。
 *
 * 与生产热路径分表，是因为那张表量的是完整业务函数，这张表量的是容器原语。
 */
export const CONTAINER_ALGORITHM_SCENARIOS: readonly ScenarioName[] = [
  "linked-timestamp-window",
  "bounded-rolling-buffer",
];

/** 七条完整生产动作的固定出数顺序：五条落盘动作与两条用户可见流程。 */
export const CHAIN_NAMES: readonly ChainName[] = [
  "join-log-append",
  "identity-policy-write",
  "chat-state-write",
  "ai-memory-snapshot",
  "diagnostic-log",
  "ad-detect-command",
  "ai-reply-command",
];

/**
 * 入群日志容量线的两项操作，一律跑 `current` 变体。
 *
 * `baseline`（优化前的整表复制与排序）留在 `bun run perf:join-log` 里当新旧
 * 对照与 checksum 等价性校验，但不进文档：这一页只报当前实现的成本。
 */
const JOIN_LOG_OPERATIONS: readonly string[] = ["snapshot", "capacity"];

/**
 * 所有子进程必须与父进程用同一个 Bun 构建。
 *
 * 混着跑出来的表面上是一份报告，实际是两个引擎的读数并排——JIT 策略、GC 与
 * SQLite 绑定都可能不同，任何一行的同比都失去意义。
 */
function assertSameRuntime(
  version: string,
  revision: string,
  label: string
): void {
  if (version !== Bun.version || revision !== Bun.revision) {
    throw new Error(
      `${label}: child ran Bun ${version} (${revision}), parent runs ` +
      `${Bun.version} (${Bun.revision}).`
    );
  }
}

async function seedRuntimeRoot(
  runtimeRoot: string,
  mode: "cold-start" | "chain",
  label: string
): Promise<void> {
  await spawnJsonChild<unknown>({
    args: [SUITE_ENTRY, "--child", "seed", mode],
    env: childEnv(runtimeRoot),
    label: `${label} fixture`,
  });
}

/** 一项测量的按轮编排参数；子进程一律从环境变量拿数据根，不从 argv 拿。 */
interface RoundsOptions {
  readonly label: string;
  readonly seedMode: SeedMode;
  readonly args: readonly string[];
}

/**
 * 按轮跑一项测量：每轮一个全新的运行时数据根，跑完整棵删掉。
 *
 * 数据根不跨轮复用：SQLite 文件长大、WAL 变脏、页缓存变热，第二轮量到的就
 * 不再是第一轮那件事了。
 */
async function runRounds<TRound>(
  context: SectionContext,
  { label, seedMode, args }: RoundsOptions
): Promise<readonly TRound[]> {
  const rounds: TRound[] = [];
  for (let round: number = 0; round < context.rounds; round += 1) {
    const runtimeRoot: string = createRuntimeRoot(context.runRoot);
    try {
      if (seedMode !== "none") await seedRuntimeRoot(runtimeRoot, seedMode, label);
      context.onProgress(`${label} ${round + 1}/${context.rounds}`);
      rounds.push(await spawnJsonChild<TRound>({
        args,
        env: childEnv(runtimeRoot),
        label,
      }));
    } finally {
      // 足迹要在删之前量：这是「跑一遍基准到底在磁盘上落了多少东西」的唯一
      // 观测点，删完再问就只剩一个空目录。
      context.recordFootprint(measureDirectoryFootprint(runtimeRoot));
      removeMockPath(runtimeRoot);
    }
  }
  return rounds;
}

/** 冷启动分区：每个启动阶段一行，单位统一是毫秒。 */
export interface ColdStartSectionResult {
  readonly section: BenchmarkSection;
  readonly summary: ColdStartSummary;
}

const COLD_START_PHASES: readonly (readonly [
  string,
  (round: ColdStartRound) => number
])[] = [
  ["module-graph", (round: ColdStartRound): number => round.phases.moduleGraphMs],
  ["instance-lock", (round: ColdStartRound): number => round.phases.instanceLockMs],
  ["orphan-cleanup", (round: ColdStartRound): number => round.phases.orphanCleanupMs],
  ["state-load", (round: ColdStartRound): number => round.phases.stateLoadMs],
  ["deployment-inputs", (round: ColdStartRound): number => round.phases.deploymentInputMs],
  ["disk-io-init", (round: ColdStartRound): number => round.phases.diskIOInitMs],
  ["persisted-load", (round: ColdStartRound): number => round.phases.persistedLoadMs],
  ["hydrate", (round: ColdStartRound): number => round.phases.hydrateMs],
  ["ready-total", (round: ColdStartRound): number => round.phases.readyMs],
];

/** 冷启动分区：满库 fixture 上跑真实启动恢复，逐段计时。 */
export async function runColdStartSection(
  context: SectionContext
): Promise<ColdStartSectionResult> {
  const rounds: readonly ColdStartRound[] = await runRounds<ColdStartRound>(
    context,
    {
      label: "cold-start",
      seedMode: "cold-start",
      args: [SUITE_ENTRY, "--child", "cold-start"],
    }
  );
  const reference: ColdStartRound = rounds[0]!;
  for (const round of rounds) {
    assertSameRuntime(round.bunVersion, round.bunRevision, "cold-start");
    context.recordIo(round.io);
    context.recordOperations(1);
    if (
      round.recovered.whitelistEntries !== reference.recovered.whitelistEntries ||
      round.recovered.chatStates !== reference.recovered.chatStates ||
      round.recovered.aiMemoryChats !== reference.recovered.aiMemoryChats
    ) {
      throw new Error("Cold-start rounds recovered different fixture sizes.");
    }
  }
  return {
    section: {
      id: "cold-start",
      entries: COLD_START_PHASES.map(([id, select]: readonly [
        string,
        (round: ColdStartRound) => number
      ]): BenchmarkEntry => ({
        id,
        metrics: [aggregateMetric("duration", "ms", rounds.map(select))],
      })),
    },
    summary: {
      recovered: reference.recovered,
      peakRssBytes: aggregateMetric(
        "peakRss",
        "bytes",
        rounds.map((round: ColdStartRound): number => round.peakRssBytes)
      ),
    },
  };
}

const HOT_PATH_METRICS: readonly MetricDefinition<HotPathRound>[] = [
  {
    metric: "medianLatency",
    unit: "ns/op",
    select: (round: HotPathRound): number => round.medianNsPerOp,
  },
  {
    metric: "throughput",
    unit: "ops/s",
    select: (round: HotPathRound): number => 1_000_000_000 / round.medianNsPerOp,
  },
  {
    metric: "peakRss",
    unit: "bytes",
    select: (round: HotPathRound): number => round.peakSampledRssBytes,
  },
  {
    metric: "retainedHeap",
    unit: "bytes",
    select: (round: HotPathRound): number => round.retainedHeapDelta,
  },
];

/** 热路径分区：直接复用 `scripts/perf/hotPaths.ts` 的场景实现与迭代规模。 */
export async function runHotPathSection(
  context: SectionContext,
  sectionId: "hot-path" | "container-algorithm",
  scenarios: readonly ScenarioName[]
): Promise<BenchmarkSection> {
  const entries: BenchmarkEntry[] = [];
  for (const scenario of scenarios) {
    const rounds: readonly HotPathRound[] = await runRounds<HotPathRound>(
      context,
      {
        label: `${sectionId}:${scenario}`,
        seedMode: "none",
        args: [HOT_PATH_ENTRY, scenario],
      }
    );
    for (const round of rounds) {
      context.recordOperations(round.iterations * round.samplesNsPerOp.length);
    }
    entries.push({ id: scenario, metrics: aggregateRounds(rounds, HOT_PATH_METRICS) });
  }
  return { id: sectionId, entries };
}

const STORAGE_METRICS: readonly MetricDefinition<StorageRound>[] = [
  {
    metric: "throughput",
    unit: "ops/s",
    select: (round: StorageRound): number => round.result.throughputPerSecond,
  },
  {
    metric: "batchLatency",
    unit: "ms",
    select: (round: StorageRound): number => round.result.meanBatchLatencyMs,
  },
  {
    metric: "writtenBytes",
    unit: "bytes",
    select: (round: StorageRound): number => round.io.writeBytes,
  },
  {
    metric: "retainedHeap",
    unit: "bytes",
    select: (round: StorageRound): number => round.result.retainedHeapDelta,
  },
];

/** 存储分区：主线程 LRU、写透 ACK 与 SQLite 冷热读写。 */
export async function runStorageSection(
  context: SectionContext
): Promise<BenchmarkSection> {
  const entries: BenchmarkEntry[] = [];
  for (const operation of STORAGE_OPERATIONS) {
    const rounds: readonly StorageRound[] = await runRounds<StorageRound>(
      context,
      {
        label: `storage:${operation}`,
        // 只有写透那一项真的在数据根里读写；其余各自在 mock 根下建临时库。
        seedMode: operation === "main-write-through-acked" ? "chain" : "none",
        args: [SUITE_ENTRY, "--child", "storage", operation],
      }
    );
    for (const round of rounds) {
      context.recordIo(round.io);
      context.recordOperations(round.result.operations);
    }
    entries.push({ id: operation, metrics: aggregateRounds(rounds, STORAGE_METRICS) });
  }
  return { id: "storage", entries };
}

const CHAIN_METRICS: readonly MetricDefinition<ChainRound>[] = [
  {
    metric: "completedThroughput",
    unit: "ops/s",
    select: (round: ChainRound): number => round.operationThroughputPerSecond,
  },
  {
    metric: "meanLatency",
    unit: "ms",
    select: (round: ChainRound): number => round.meanLatencyMs,
  },
  {
    metric: "p50Latency",
    unit: "ms",
    select: (round: ChainRound): number => round.p50LatencyMs,
  },
  {
    metric: "p95Latency",
    unit: "ms",
    select: (round: ChainRound): number => round.p95LatencyMs,
  },
  {
    metric: "maxLatency",
    unit: "ms",
    select: (round: ChainRound): number => round.maxLatencyMs,
  },
  {
    metric: "recordThroughput",
    unit: "records/s",
    select: (round: ChainRound): number => round.throughputPerSecond,
  },
  {
    metric: "writtenBytes",
    unit: "bytes",
    select: (round: ChainRound): number => round.io.writeBytes,
  },
];

/** 完整流程分区：五条 durable 动作与两条本地命令流程的单次耗时及吞吐。 */
export async function runChainSection(
  context: SectionContext
): Promise<BenchmarkSection> {
  const entries: BenchmarkEntry[] = [];
  for (const chain of CHAIN_NAMES) {
    const rounds: readonly ChainRound[] = await runRounds<ChainRound>(
      context,
      {
        label: `chain:${chain}`,
        seedMode: "chain",
        args: [SUITE_ENTRY, "--child", "chain", chain],
      }
    );
    for (const round of rounds) {
      assertSameRuntime(round.bunVersion, round.bunRevision, `chain:${chain}`);
      context.recordIo(round.io);
      context.recordOperations(round.operations * round.recordsPerOperation);
    }
    entries.push({ id: chain, metrics: aggregateRounds(rounds, CHAIN_METRICS) });
  }
  return { id: "chain", entries };
}

/** 入群日志容量线的一次子进程读数；字段取自 `scripts/perf/joinLog.ts`。 */
interface JoinLogRound {
  readonly recordCount: number;
  readonly elapsedMs: number;
  readonly retainedHeapDelta: number;
  readonly heapDeltaBeforeGc: number;
}

const JOIN_LOG_METRICS: readonly MetricDefinition<JoinLogRound>[] = [
  {
    metric: "elapsed",
    unit: "ms",
    select: (round: JoinLogRound): number => round.elapsedMs,
  },
  {
    metric: "allocatedHeap",
    unit: "bytes",
    select: (round: JoinLogRound): number => round.heapDeltaBeforeGc,
  },
  {
    metric: "retainedHeap",
    unit: "bytes",
    select: (round: JoinLogRound): number => round.retainedHeapDelta,
  },
];

/** 入群日志 25 万容量线：复用既有子进程，只跑当前实现。 */
export async function runJoinLogSection(
  context: SectionContext
): Promise<BenchmarkSection> {
  const entries: BenchmarkEntry[] = [];
  for (const operation of JOIN_LOG_OPERATIONS) {
    const rounds: readonly JoinLogRound[] = await runRounds<JoinLogRound>(
      context,
      {
        label: `join-log:${operation}`,
        seedMode: "none",
        args: [JOIN_LOG_ENTRY, "--child", operation, "current"],
      }
    );
    for (const round of rounds) context.recordOperations(round.recordCount);
    entries.push({
      id: operation,
      metrics: aggregateRounds(rounds, JOIN_LOG_METRICS),
    });
  }
  return { id: "join-log-capacity", entries };
}
