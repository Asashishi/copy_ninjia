/** 进程停机排空、轮询与落盘的统一时间预算。 */

import { TELEGRAM_REPEATED_OFFSET_MIN_WAIT_MS } from "./telegram";
import type { FlushTimeouts } from "../types/lifecycle";

/** 等待 grammY runner 中在途 update 处理完毕的最长时间。 */
export const RUNNER_DRAIN_TIMEOUT_MS: number = 5_000;
/** 等待 runner 归零时的轮询间隔。 */
export const RUNNER_DRAIN_POLL_INTERVAL_MS: number = 100;
/**
 * 正常 drain 超时并 abort 活跃 update 后，等待 handler 响应取消的附加预算。
 * 所属模块：app/lifecycle/maintenance.ts。
 */
export const RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS: number = 1_000;
/**
 * 正常停机时确认最终 Telegram update offset 的本地网络截止。
 *
 * 最终确认的 offset 与在途长轮询相同，Bot API 服务端会把其中一部分请求按
 * TELEGRAM_REPEATED_OFFSET_MIN_WAIT_MS 挂起后才应答；本截止为这段等待加一段
 * DNS、建连与响应读取的余量。请求另带 AbortSignal，到截止即中止。所属模块：app/lifecycle.ts。
 */
export const FINAL_OFFSET_CONFIRM_TIMEOUT_MS: number = TELEGRAM_REPEATED_OFFSET_MIN_WAIT_MS + 5_000;

/** 正常停机时各持久化 owner 的独立 flush 预算。 */
export const AI_MEMORY_FLUSH_TIMEOUT_MS: number = 2_000;
/**
 * /ai_chat disable 等待旧 generation 的模型、工具与 Telegram 副作用收敛的预算。
 * 所属模块：aiChat/workerBridge.ts。
 */
export const AI_CHAT_INVALIDATE_TIMEOUT_MS: number = 10_000;
/**
 * Worker 侧等待旧 generation 任务 settle 的预算，到点即降级放行并回执。
 *
 * 必须**小于** AI_CHAT_INVALIDATE_TIMEOUT_MS：主线程那道预算从投出
 * invalidateChat 起算，Worker 用满自己的预算之后仍要留出回执路由的时间。
 *
 * 降级放行时，登记进来的任务全部按 generation 自检（见 compaction.ts 的
 * rotateCompaction），失效之后即使跑完也不写任何东西；等待不是正确性前提。
 * 记忆压缩把同代 AbortSignal 传给摘要请求和退避等待；代际失效后停止后续重采样，
 * 已返回的结果仍需通过代际检查。
 * 所属模块：workers/aiChat/replyGeneration.ts。
 */
export const AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS: number = 7_000;
/** 正常停机等待 Disk I/O Worker flush 的预算。 */
export const DISK_IO_FLUSH_TIMEOUT_MS: number = 3_000;
/**
 * terminateDiskIO 等待 Worker 关闭共享 SQLite（提交残余写、TRUNCATE checkpoint、关库）回执的预算，
 * 独立于 DISK_IO_FLUSH_TIMEOUT_MS，也不随 FlushTimeouts（含 EMERGENCY_FLUSH_TIMEOUTS）缩放；超时时
 * 无法确认残余写已提交，照常 terminate 后把这一步记为失败。所属模块：infra/diskIO.ts。
 */
export const DISK_IO_STORAGE_CLOSE_TIMEOUT_MS: number = 1_500;
/** 正常停机等待全局状态文件写入的预算。 */
export const STATE_FLUSH_TIMEOUT_MS: number = 3_000;
/** 正常停机时头像、翻译、Anti-Raid、gag、/wed、延迟命令、cron、延迟删除与 Telegram 出站各 owner 的排空预算，也是等待后台维护收尾的预算（见 app/lifecycle/shutdown.ts 的 SHUTDOWN_DRAIN_OWNERS）。 */
const BACKGROUND_MAINTENANCE_TIMEOUT_MS: number = 3_000;

/** 单次 Google Translation RPC 的上限。 */
export const TRANSLATE_REQUEST_TIMEOUT_MS: number = 2_500;

/** 未捕获异常路径的尽力落盘预算。 */
const EMERGENCY_FLUSH_TIMEOUT_MS: number = 1_000;
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

/** 未捕获异常路径采用的完整、短预算组合；terminateDiskIO 的关库另按 DISK_IO_STORAGE_CLOSE_TIMEOUT_MS 等待。 */
export const EMERGENCY_FLUSH_TIMEOUTS: Readonly<FlushTimeouts> = {
  aiMemoryMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  diskIOMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  stateMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  maintenanceMs: 0,
};
