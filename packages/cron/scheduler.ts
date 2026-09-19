/**
 * cron.json 定时任务的主线程调度器（状态见 cache/main/cron.ts）。
 *
 * 每个任务按 `cron` 表达式注册一个 Bun 原生进程内 cron（带任务时区，unref）。handler
 * 返回本轮 Promise，Bun 在它结算之后才排下一次，同一任务不会重叠：
 * - 普通任务：每次触发跑一轮；
 * - just_once：首次触发先停掉 cron、登记执行记录，再跑一轮；
 * - rand_cron：首次按 cron 触发后停掉 cron，此后每轮结束再用一个 unref 的 setTimeout
 *   在 [min, max] 内均匀随机等待。
 *
 * 热重载按任务名对账（reconcileCronSchedule）：深相等的任务保留句柄与随机计时；变更
 * 或删除的任务停止调度并标记撤销，在途一轮在下一个动作或重试前停下；新增的任务
 * 登记。just_once 记录只在任务仍是 just_once 时保留，转为周期任务即清除；删除后同名
 * 加回仍按已执行处理。停机期间错过的触发不补发；记录与随机计时都不持久化。
 * 所有 handler 自行吞掉异常：Bun.cron 的 reject 会成为 unhandledRejection 触发紧急退出。
 */

import { cronRuntime } from "../cache/main/cron";
import { getCronConfig } from "../config/cron";
import { CRON_JUST_ONCE_RECORD_MAX } from "../consts/cron";
import { logger } from "../infra/logger";
import { settleWithinBudget } from "../libs/inflight";
import { LruCache } from "../libs/lruCache";
import { runCronRound } from "./run";
import type { CronConfig, CronRuntime, CronTask, CronTaskSchedule } from "../types/cron";
import type { FlushResult } from "../types/lifecycle";

/** 停掉一个调度的 cron 与随机 timer，并标记撤销。 */
function cancelSchedule(schedule: CronTaskSchedule): void {
  schedule.cancelled = true;
  schedule.job?.stop();
  schedule.job = null;
  if (schedule.timer !== null) clearTimeout(schedule.timer);
  schedule.timer = null;
}

/** 跑一轮并登记到在途集合，结算自摘除；轮内异常只记日志。 */
async function trackRound(runtime: CronRuntime, schedule: CronTaskSchedule): Promise<void> {
  const round: Promise<void> = runCronRound(schedule, runtime.controller.signal).catch((error: unknown): void => {
    logger.error(`Cron task "${schedule.task.name}" run failed unexpectedly:`, error);
  });
  runtime.runs.add(round);
  try {
    await round;
  } finally {
    runtime.runs.delete(round);
  }
}

/** rand_cron：本轮结束后在区间内均匀随机等待，再触发下一轮。 */
function armRandomTimer(runtime: CronRuntime, schedule: CronTaskSchedule): void {
  const interval: CronTask["randomInterval"] = schedule.task.randomInterval;
  if (interval === undefined || !runtime.accepting || schedule.cancelled) return;
  const delayMs: number = interval.minMs + Math.floor(Math.random() * (interval.maxMs - interval.minMs + 1));
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    schedule.timer = null;
    void fireCronTask(schedule);
  }, delayMs);
  timer.unref();
  schedule.timer = timer;
}

/** 一次触发（cron 或随机 timer）；不抛出。 */
async function fireCronTask(schedule: CronTaskSchedule): Promise<void> {
  const runtime: CronRuntime | null = cronRuntime.current;
  if (runtime === null || !runtime.accepting || schedule.cancelled) return;
  const task: Readonly<CronTask> = schedule.task;
  if (task.justOnce || task.randomInterval !== undefined) {
    schedule.job?.stop();
    schedule.job = null;
  }
  if (task.justOnce) runtime.justOnceRecords.set(task.name, true);
  await trackRound(runtime, schedule);
  armRandomTimer(runtime, schedule);
}

/** 为一个任务注册 Bun 原生 cron。 */
function registerSchedule(task: Readonly<CronTask>): CronTaskSchedule {
  const schedule: CronTaskSchedule = { task, job: null, timer: null, cancelled: false };
  schedule.job = Bun.cron(task.cron, (): Promise<void> => fireCronTask(schedule), { tz: task.timeZone }).unref();
  return schedule;
}

/**
 * 按当前任务表对账调度；调度器未启动或已停止接纳时不做事。热重载在 cron.json 变化
 * 后调用（见 app/configReload.ts）。
 */
export function reconcileCronSchedule(): void {
  const runtime: CronRuntime | null = cronRuntime.current;
  if (!runtime?.accepting) return;
  const config: CronConfig = getCronConfig();
  const next: Map<string, Readonly<CronTask>> = new Map();
  for (const task of config) next.set(task.name, task);
  for (const [name, schedule] of runtime.schedules) {
    const task: Readonly<CronTask> | undefined = next.get(name);
    if (task !== undefined && Bun.deepEquals(task, schedule.task)) continue;
    cancelSchedule(schedule);
    runtime.schedules.delete(name);
  }
  for (const task of config) {
    // 当前任务表里的 just_once 名字每轮刷新 LRU 位置；转为周期任务即清除记录。
    if (!task.justOnce) runtime.justOnceRecords.delete(task.name);
    else if (runtime.justOnceRecords.get(task.name) === true) continue;
    if (runtime.schedules.has(task.name)) continue;
    runtime.schedules.set(task.name, registerSchedule(task));
  }
}

/** 启动时创建调度器并按启动总闸接管的任务表登记；上一代还有在途轮次时禁止重建。 */
export function startCronScheduler(): void {
  const previous: CronRuntime | null = cronRuntime.current;
  if (previous !== null && previous.runs.size > 0) {
    throw new Error("Cannot start the cron scheduler while runs are unsettled.");
  }
  if (previous !== null) {
    for (const schedule of previous.schedules.values()) cancelSchedule(schedule);
    previous.controller.abort();
  }
  cronRuntime.current = {
    accepting: true,
    controller: new AbortController(),
    schedules: new Map(),
    runs: new Set(),
    justOnceRecords: new LruCache<string, true>(CRON_JUST_ONCE_RECORD_MAX),
  };
  reconcileCronSchedule();
}

/** 停机关闭接纳并停掉全部 cron 与随机 timer；在途轮次交给 drainCronScheduler。可重复调用。 */
export function quiesceCronScheduler(): void {
  const runtime: CronRuntime | null = cronRuntime.current;
  if (runtime === null) return;
  runtime.accepting = false;
  for (const schedule of runtime.schedules.values()) cancelSchedule(schedule);
}

/** 等待在途轮次结算；预算耗尽时取消在途请求与等待，零预算可用于紧急停机。 */
export async function drainCronScheduler(timeoutMs: number): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Cron drain timeout must be finite and non-negative.");
  quiesceCronScheduler();
  const runtime: CronRuntime | null = cronRuntime.current;
  if (runtime === null || runtime.runs.size === 0) return "flushed";
  if (timeoutMs > 0 && await settleWithinBudget(runtime.runs, timeoutMs)) return "flushed";
  runtime.controller.abort();
  return "timedOut";
}
