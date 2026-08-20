/**
 * 全量性能基准的公共契约：子进程回传的原始读数、三轮聚合后的指标，以及
 * 最终报告的形状。
 *
 * 单独成文件是为了让父进程（编排与渲染）不必 import 任何会拉起生产模块图的
 * 子进程实现——父进程一旦静态 import 了 coldStart/chain，它自己就先把整张
 * 生产模块图加载进来了，冷启动那一段读数当场失效。
 */

import type { ChildResult as IdentityChildResult } from "../identityDatabase/types";

/** `/proc/<pid>/io` 在一次计时窗口内的增量；Linux 专属，本项目本就只支持 Linux。 */
export interface ProcessIoDelta {
  /** 进程视角读入的字节数（含命中页缓存的部分）。 */
  readonly rcharBytes: number;
  /** 进程视角写出的字节数（含尚未落到块设备的部分）。 */
  readonly wcharBytes: number;
  /** 真正从块设备读入的字节数。 */
  readonly readBytes: number;
  /** 真正提交给块设备的字节数。 */
  readonly writeBytes: number;
  /** 读系统调用次数。 */
  readonly readSyscalls: number;
  /** 写系统调用次数。 */
  readonly writeSyscalls: number;
}

/** 冷启动各阶段耗时；口径与 `packages/app/lifecycle.ts` 的 init 顺序一致。 */
export interface ColdStartPhaseTimings {
  /** 动态 import 生产模块图直到可调用的耗时。 */
  readonly moduleGraphMs: number;
  /** 取得数据根单实例锁（含数据根 durability 预检）的耗时。 */
  readonly instanceLockMs: number;
  /** 清扫原子写中断残留临时文件的耗时。 */
  readonly orphanCleanupMs: number;
  /** 读取并严格解析 state.json 的耗时。 */
  readonly stateLoadMs: number;
  /** 校验既有部署输入（config/ 各文件与人设）的耗时。 */
  readonly deploymentInputMs: number;
  /** 创建 Disk I/O Worker 的耗时。 */
  readonly diskIOInitMs: number;
  /** 启动恢复握手：SQLite 全量读 + memory/ 各快照解析的耗时。 */
  readonly persistedLoadMs: number;
  /** 把恢复结果灌进主线程热缓存的耗时。 */
  readonly hydrateMs: number;
  /** 从进程启动到恢复就绪的墙钟耗时，含 Bun 自身启动。 */
  readonly readyMs: number;
}

/** 冷启动子进程实际恢复到的数据量，用来证明这一轮真的读到了 fixture。 */
export interface ColdStartRecovered {
  readonly aiMemoryChats: number;
  readonly chatStates: number;
  readonly whitelistEntries: number;
  readonly blocklistEntries: number;
  readonly pendingRemovals: number;
}

/** 冷启动子进程一轮的完整回传。 */
export interface ColdStartRound {
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly phases: ColdStartPhaseTimings;
  readonly recovered: ColdStartRecovered;
  readonly io: ProcessIoDelta;
  readonly peakRssBytes: number;
}

/** 五条真实落盘动作与两条用户可见本地流程；全部从生产入口驱动。 */
export type ChainName =
  | "join-log-append"
  | "identity-policy-write"
  | "chat-state-write"
  | "ai-memory-snapshot"
  | "diagnostic-log"
  | "ad-detect-command"
  | "ai-reply-command";

/** 单条链路一轮的完整回传；延迟分位数来自逐次 durable 往返。 */
export interface ChainRound {
  readonly chain: ChainName;
  readonly bunVersion: string;
  readonly bunRevision: string;
  /** 计时窗口内完成的 durable 往返次数。 */
  readonly operations: number;
  /** 一次往返承载的业务记录数；批量链路大于 1。 */
  readonly recordsPerOperation: number;
  readonly elapsedMs: number;
  /**
   * 完整处理吞吐（ops/s）：每秒能从生产入口跑完多少次该动作。
   *
   * 五条落盘动作的终点是 durable 回执；广告检测与 AI 回复的终点分别是处置
   * 排空与消息发送完成。批量动作的 `throughputPerSecond` 按记录折算，天然是它
   * 的 recordsPerOperation 倍，不能替代这一口径比较一次完整动作的成本。
   */
  readonly operationThroughputPerSecond: number;
  /** 业务记录吞吐（records/s），已按 recordsPerOperation 折算。 */
  readonly throughputPerSecond: number;
  readonly meanLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly maxLatencyMs: number;
  readonly io: ProcessIoDelta;
  readonly peakRssBytes: number;
  readonly checksum: number;
}

/**
 * 存储分区一轮的回传：直接复用 `perf:identity-database` 的逐次读数，外加这个
 * 子进程整个生命周期的读写量。
 *
 * `io` 的口径与冷启动、链路两个分区**不同**：那两个分区量的是计时窗口内的读写，
 * 这里覆盖的是整个子进程，含 fixture 建库那一段。总量表用的正是这个口径——
 * 「跑完一遍全量基准，磁盘上到底发生了多少读写」。
 */
export interface StorageRound {
  readonly result: IdentityChildResult;
  readonly io: ProcessIoDelta;
}

/** 热路径子进程一轮的摘要；原始字段由 `scripts/perf/hotPaths.ts` 产出。 */
export interface HotPathRound {
  readonly scenario: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly iterations: number;
  /** 各计时样本的 ns/op；长度即样本数，用来折算这一轮跑了多少次操作。 */
  readonly samplesNsPerOp: readonly number[];
  readonly medianNsPerOp: number;
  readonly peakSampledRssBytes: number;
  readonly retainedHeapDelta: number;
  readonly retainedObjectDelta: number;
}

/** 指标单位；渲染层按它决定小数位与千分位。 */
export type MetricUnit =
  | "ns/op"
  | "ops/s"
  | "records/s"
  | "ms"
  | "bytes"
  | "count"
  | "percent";

/** 一项指标在全部轮次上的聚合读数。 */
export interface MetricStats {
  readonly metric: string;
  readonly unit: MetricUnit;
  readonly samples: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  /** 变异系数（标准差 / 平均值），用来判断这次读数是否稳定到可比。 */
  readonly coefficientOfVariationPercent: number;
}

/** 报告里的一行被测对象：一个场景、一条链路或一项存储操作。 */
export interface BenchmarkEntry {
  readonly id: string;
  readonly metrics: readonly MetricStats[];
}

/** 报告分区 id；渲染顺序即数组顺序。 */
export type SectionId =
  | "cold-start"
  | "hot-path"
  | "container-algorithm"
  | "storage"
  | "chain"
  | "join-log-capacity";

/** 一个报告分区。 */
export interface BenchmarkSection {
  readonly id: SectionId;
  readonly entries: readonly BenchmarkEntry[];
}

/**
 * 冷启动分区的旁注：恢复到的数据量与进程峰值 RSS。
 *
 * 不做成分区里的一行：分区那张表的每一行都是一个启动阶段、单位都是毫秒，
 * 把「恢复了多少条」和「峰值多少字节」塞进同一张表只会让列的含义按行变化。
 */
export interface ColdStartSummary {
  readonly recovered: ColdStartRecovered;
  readonly peakRssBytes: MetricStats;
}

/** 整轮基准的读写与吞吐合计；按轮平均，代表「跑完一遍全量基准」的量。 */
export interface SuiteTotals {
  /** 全部分区在一轮里完成的被测操作数合计。 */
  readonly measuredOperations: number;
  readonly rcharBytes: number;
  readonly wcharBytes: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly readSyscalls: number;
  readonly writeSyscalls: number;
  /** 一轮结束时 mock 数据根实际占用的字节数。 */
  readonly mockRootBytes: number;
  /** 一轮结束时 mock 数据根里的文件数。 */
  readonly mockRootFiles: number;
}

/** 出数机器与运行时；换任何一项都会让读数不可与历史比较。 */
export interface SuiteEnvironment {
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly platform: string;
  readonly arch: string;
  readonly kernel: string;
  /**
   * 逻辑核心数；刻意不记录 CPU 型号。
   *
   * 型号既不参与任何读数的解释，又把出数机器的具体硬件写进了公开文档；判断一
   * 份读数能不能和历史比，看的是核心数、内存和 Bun 构建这三项。
   */
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
}

/** 全量基准的最终报告；`--markdown` 与 `--write-readme` 都从它渲染。 */
export interface FullSuiteReport {
  readonly generatedAt: string;
  readonly rounds: number;
  readonly wallClockMs: number;
  readonly mockDataRoot: string;
  readonly environment: SuiteEnvironment;
  readonly sections: readonly BenchmarkSection[];
  readonly coldStart: ColdStartSummary;
  readonly totals: SuiteTotals;
}
