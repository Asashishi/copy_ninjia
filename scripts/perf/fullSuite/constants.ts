/**
 * 全量性能基准的规模与口径常量。
 *
 * 与 `packages/consts/` 的分工：那边是生产运行时读的部署常量，这里只服务
 * `scripts/` 下这一个一次性 CLI，改这些数不影响任何生产行为，但会让历史读数
 * 不可比——调整任何一项都要在 README 的基准区块里重新出数。
 */

import { MAIN_BENCHMARK_ROOT_PREFIX } from "../identityDatabase/constants";
import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  MAX_SUMMARY_ROUNDS,
} from "../../../packages/consts/aiChat/memory";
import { CHAT_QA_MAX_PER_CHAT } from "../../../packages/consts/qa";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";

/** 每一项测量重复的独立轮数；报告按轮取平均，并附最小值、最大值与变异系数。 */
export const FULL_SUITE_ROUNDS: number = 3;

/** mock 数据根目录名，位于仓库根下且不进 Git；本基准只允许在它内部建删文件。 */
export const PERFORMANCE_MOCK_ROOT_NAME: string = "performance";

/** 单次运行在 mock 根下独占的目录前缀；跑完整棵删除。 */
export const RUN_ROOT_PREFIX: string = "run-";

/** 单次运行使用的隔离配置目录名；只放在对应的 run-* 目录内。 */
export const BENCHMARK_CONFIG_ROOT_NAME: string = "config";

/** 性能夹具使用的非占位 Agent 凭据；出站仍由 outboundGuard 统一截断。 */
export const BENCHMARK_AGENT_API_KEY: string = "benchmark-only-agent-api-key";

/** 性能夹具使用的非占位 Telegram token；不会交给真实 Telegram 客户端。 */
export const BENCHMARK_BOT_TOKEN: string =
  "123456789:benchmark-only-telegram-bot-token";

/**
 * 每轮运行时数据根在本次运行目录下的前缀（充当 COPY_NINJIA_DATA_ROOT）。
 *
 * 直接取自 `MAIN_BENCHMARK_ROOT_PREFIX` 而不是另写一份同名字符串：存储分区
 * 复用 `identityDatabase/mainThread.ts` 的写透子进程，它自带「数据根必须以该
 * 前缀命名」的自检，两处各写一份迟早会漂移成一次莫名其妙的子进程失败。
 */
export const RUNTIME_ROOT_PREFIX: string = MAIN_BENCHMARK_ROOT_PREFIX;

/**
 * 冷启动 fixture 的白/黑名单行数，各取主线程 LRU 容量
 * （`IDENTITY_READ_CACHE_MAX_ENTRIES` = 8192）的一倍。
 * 启动恢复只读计数不读整表，这个量级用于让 SQLite 真的有页要读。
 */
export const COLD_START_IDENTITY_ROWS: number = 8_192;

/** 冷启动 fixture 的群状态行数；生产硬顶就是这个值，直接顶满测最坏情况。 */
export const COLD_START_CHAT_STATE_ROWS: number = STATE_MANAGED_CHAT_LIMIT;

/** 冷启动 fixture 的群问答行数；25 个受管群各自顶满每群 15 条的生产硬顶。 */
export const COLD_START_CHAT_QA_ROWS: number =
  STATE_MANAGED_CHAT_LIMIT * CHAT_QA_MAX_PER_CHAT;

/** 冷启动 fixture 的待踢成员 outbox 行数。 */
export const COLD_START_REMOVAL_ROWS: number = 512;

/** 冷启动 fixture 的 AI 记忆快照群数；每群一个 memory/ai/<chatId>.json。 */
export const COLD_START_AI_MEMORY_CHATS: number = STATE_MANAGED_CHAT_LIMIT;

/**
 * 每份 AI 记忆快照里的逐字消息条数与摘要轮数，直接取生产恢复上限：
 * 冷启动要量的是最坏情况，而这两个数正是启动恢复肯接受的最大快照。
 * 超过任何一个，启动恢复都会判定 schema 非法并拒绝启动。
 */
export const COLD_START_AI_MEMORY_MESSAGES: number = AI_MEMORY_HYDRATE_BUFFER_MAX;

/** 见 `COLD_START_AI_MEMORY_MESSAGES`。 */
export const COLD_START_AI_MEMORY_SUMMARIES: number = MAX_SUMMARY_ROUNDS;

/** 冷启动 fixture 预写的入群日志条数，覆盖启动时的保留窗口校验。 */
export const COLD_START_JOIN_LOG_EVENTS: number = 2_000;

/** 入群日志链路的计时事件数；每条都走 post + flush 的完整 durable 往返。 */
export const CHAIN_JOIN_LOG_EVENTS: number = 1_000;

/** 身份策略写透链路的计时批次数；每批 `IDENTITY_WRITE_BATCH_MAX_ENTRIES` 条。 */
export const CHAIN_IDENTITY_BATCHES: number = 200;

/** 临时白名单资格判定到 SQLite 精确 ACK 的计时次数。 */
export const CHAIN_TEMPORARY_WHITELIST_WRITES: number = 400;

/** 群状态 durable 屏障链路的计时次数；写入在固定群集合上轮转。 */
export const CHAIN_CHAT_STATE_WRITES: number = 400;

/** 群问答 durable 屏障链路的计时次数；覆盖固定问题的新增与后续替换。 */
export const CHAIN_CHAT_QA_WRITES: number = 400;

/**
 * AI 记忆快照原子重写链路的计时次数。
 *
 * 每次都要把一份撑满恢复上限（COLD_START_AI_MEMORY_MESSAGES 即
 * AI_MEMORY_HYDRATE_BUFFER_MAX）的快照整份 tmp + fsync + rename 落盘，实测约
 * 46 KiB、单次 p50 个位数毫秒。
 *
 * 加样本治不了这一行的轮间摆动。空载单跑 150 次三轮是稳的（约 185 ops/s，
 * CV 个位数），但同一条链路在整套基准里量到过 41 与 130 ops/s——差别不是采样
 * 噪声，而是它排在冷启动、热路径、存储几个分区之后，吃的是那些分区累积下来的
 * 文件系统写回压力。吞吐取的是均值，长尾一抬整行就跟着走；p50 反而稳。要压住
 * 它得改的是分区间的隔离，不是这个数字，因此维持 150。
 */
export const CHAIN_AI_MEMORY_SNAPSHOTS: number = 150;

/** error 日志诊断通道链路的计时条数。 */
export const CHAIN_LOG_ENTRIES: number = 1_000;

/**
 * 广告判定完整命令链路的计时条数。
 *
 * 一条 = 一条群消息从入队到「黑名单落盘 + 移除 outbox 落盘 + 处置排空」的全程，
 * 中间的模型判定用罐头响应顶掉（见 scripts/perf/outboundGuard.ts）。每条至少两次
 * fsync，取 150 条与 AI 记忆快照同量级，分位数已经稳定。
 */
export const CHAIN_AD_DETECT_COMMANDS: number = 150;

/**
 * AI 回复完整命令链路的计时条数。
 *
 * 一条 = 一条群消息进滚动记忆、起一轮回复、组装提示词、拿到模型输出（罐头）、
 * 发出回复、再把这一轮的记忆快照落盘。触发在 STATE_MANAGED_CHAT_LIMIT 个群上
 * 轮转，避开单群 5 分钟 150 次的限频闸——顶到限频后走的是「发一条限频提示」的
 * 另一条分支，读数会突然变快且不再是同一件事。
 */
export const CHAIN_AI_REPLY_COMMANDS: number = 40;

/** AI 回复链路的预热次数；每次都要真等一段拟人停顿，不能按通用的 64 次来。 */
export const AI_REPLY_WARMUP_OPERATIONS: number = 8;

/** 单条 AI 回复等待本轮结算的轮询上限；超过按失败处理。 */
export const AI_REPLY_SETTLE_ATTEMPTS: number = 500;

/** 单条广告命令等待处置排空的预算；超时按失败处理，不接受半截链路。 */
export const AD_DETECT_DRAIN_BUDGET_MS: number = 30_000;

/** 等待机器人权限快照落位的轮询步长与次数上限（计时窗口之外）。 */
export const BOT_PERMISSION_WAIT_STEP_MS: number = 10;
export const BOT_PERMISSION_WAIT_ATTEMPTS: number = 200;

/** 各链路正式计时前的预热次数，让 Worker 侧文件句柄与 JIT 进入稳态。 */
export const CHAIN_WARMUP_OPERATIONS: number = 64;

/** 单个子进程允许运行的最长时间；超时按失败处理，不接受半截读数。 */
export const CHILD_TIMEOUT_MS: number = 600_000;

/** README 基准区块的起止标记；重跑基准按标记整块替换。 */
export const README_BLOCK_START: string = "<!-- performance-benchmark:start -->";

/** 见 `README_BLOCK_START`。 */
export const README_BLOCK_END: string = "<!-- performance-benchmark:end -->";
