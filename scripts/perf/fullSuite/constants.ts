/**
 * 全量性能基准的规模与口径常量。
 *
 * 仅供基准 CLI 使用，夹具引用生产容量。规模或分区变化后须重新生成三语性能文档
 * 与结构化报告，见 docs/cn/05-dev-workflow.md 的发布流程。
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
 * 与 identityDatabase/mainThread.ts 的写透子进程共用前缀及数据根隔离校验。
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
 * 每份快照的消息数取生产恢复上限 AI_MEMORY_HYDRATE_BUFFER_MAX，
 * 计时包含临时文件写入、fsync、原子 rename 与 durable 回执。
 */
export const CHAIN_AI_MEMORY_SNAPSHOTS: number = 150;

/** error 日志诊断通道链路的计时条数。 */
export const CHAIN_LOG_ENTRIES: number = 1_000;

/**
 * 广告判定完整命令链路的计时条数。
 *
 * 一条 = 一条群消息从入队到「黑名单落盘 + 移除 outbox 落盘 + 处置排空」的全程，
 * 模型与 Telegram 使用 scripts/perf/outboundGuard.ts 的固定应答。
 */
export const CHAIN_AD_DETECT_COMMANDS: number = 150;

/**
 * AI 回复完整命令链路的计时条数。
 *
 * 一条 = 一条群消息进滚动记忆、起一轮回复、组装提示词、拿到模型输出（罐头）、
 * 发出回复并结算本轮。定时记忆快照由独立链路计时；拟人停顿逐次实测后扣除。
 * 触发在 STATE_MANAGED_CHAT_LIMIT 个群上轮转，保持每群请求数处于生产限频内。
 */
export const CHAIN_AI_REPLY_COMMANDS: number = 40;

/** AI 回复链路的预热次数；每次完整执行一轮回复及生产拟人停顿。 */
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

/** 三语性能文档的基准区块起始标记；重跑时整块替换。 */
export const README_BLOCK_START: string = "<!-- performance-benchmark:start -->";

/** 见 `README_BLOCK_START`。 */
export const README_BLOCK_END: string = "<!-- performance-benchmark:end -->";
