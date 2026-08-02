/** 进程停机排空、轮询与落盘的统一时间预算。 */

import type { FlushTimeouts } from "../types/lifecycle";

/** 等待 grammY runner 中在途 update 处理完毕的最长时间与轮询间隔。 */
export const RUNNER_DRAIN_TIMEOUT_MS: number = 5_000;
/** 等待 runner 归零时的轮询间隔。 */
export const RUNNER_DRAIN_POLL_INTERVAL_MS: number = 100;
/**
 * 正常 drain 超时并 abort 活跃 update 后，等待 handler 响应取消的附加预算。
 * 所属模块：app/lifecycle.ts。
 */
export const RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS: number = 1_000;
/**
 * 正常停机时确认最终 Telegram update offset 的本地网络截止。
 *
 * Bot API 的 `timeout: 0` 只关闭服务端 long polling，不限制 DNS、建连或响应体
 * 读取；必须另带 AbortSignal，避免一次网络半开让正常停机永远卡在最终确认。
 * 所属模块：app/lifecycle.ts。
 */
export const FINAL_OFFSET_CONFIRM_TIMEOUT_MS: number = 3_000;

/** 正常停机时各持久化 owner 的独立 flush 预算。 */
export const AI_MEMORY_FLUSH_TIMEOUT_MS: number = 2_000;
/**
 * /ai_chat disable 等待旧 generation 的模型、工具与 Telegram 副作用收敛的预算。
 * 所属模块：aiChat/index.ts。
 */
export const AI_CHAT_INVALIDATE_TIMEOUT_MS: number = 10_000;
/**
 * Worker 侧等待旧 generation 任务 settle 的预算，到点即降级放行并回执。
 *
 * 必须**明显小于** AI_CHAT_INVALIDATE_TIMEOUT_MS：主线程那道 10 秒是从投出
 * invalidateChat 起算的，Worker 拖满自己的预算之后还要留出回执路由的时间，
 * 否则主线程先超时 reject，异常一路逃进 grammY 中间件——那条 update 判失败、
 * 最终 offset 被扣住，重启后 Telegram 重投同一条指令。
 *
 * 降级是安全的：登记进来的任务全部按 generation 自检（见 compaction.ts 的
 * rotateCompaction），失效之后即使跑完也不会再写任何东西；等待只是想让停顿
 * 看起来干净，不是正确性前提。记忆压缩的业务重采样链仍拿不到 AbortSignal，
 * 候选为空时的退避加请求超时最坏能跑数分钟。
 * 所属模块：workers/aiChat/replyGeneration.ts。
 */
export const AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS: number = 7_000;
/** 正常停机等待 Disk I/O Worker flush 的预算。 */
export const DISK_IO_FLUSH_TIMEOUT_MS: number = 3_000;
/** 正常停机等待 state 主/LKG 写入的预算。 */
export const STATE_FLUSH_TIMEOUT_MS: number = 3_000;
/** 正常停机等待头像、反应与翻译 owner 的预算。 */
export const BACKGROUND_MAINTENANCE_TIMEOUT_MS: number = 3_000;

/** 单次 Google Translation RPC 的上限，避免在途翻译无限阻塞停机。 */
export const TRANSLATE_REQUEST_TIMEOUT_MS: number = 2_500;

/** 未捕获异常路径的尽力落盘预算；避免故障进程在清理阶段久留。 */
export const EMERGENCY_FLUSH_TIMEOUT_MS: number = 1_000;
/**
 * 普通关停已在途时发生致命异常，复用该关停 Promise 所允许的绝对最长时间。
 * 该截止独立于各 owner 的 flush 预算，属于生命周期模块的最终强制退出边界。
 */
export const EMERGENCY_REUSED_DISPOSE_DEADLINE_MS: number = 15_000;

/** 正常停机与异常退出路径各自采用一组完整、不可拆散的时间预算。 */
export const NORMAL_FLUSH_TIMEOUTS: Readonly<FlushTimeouts> = {
  aiMemoryMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
  diskIOMs: DISK_IO_FLUSH_TIMEOUT_MS,
  stateMs: STATE_FLUSH_TIMEOUT_MS,
  maintenanceMs: BACKGROUND_MAINTENANCE_TIMEOUT_MS,
};

/** 未捕获异常路径采用的完整、短预算组合。 */
export const EMERGENCY_FLUSH_TIMEOUTS: Readonly<FlushTimeouts> = {
  aiMemoryMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  diskIOMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  stateMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  maintenanceMs: 0,
};
