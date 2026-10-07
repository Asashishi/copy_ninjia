/**
 * cron.json 定时任务的主线程调度器（状态见 cache/main/cron.ts）。
 *
 * 每个任务按 `cron` 表达式注册一个 Bun 原生进程内 cron（带任务时区，unref）。handler
 * 返回本轮 Promise，Bun 在它结算之后才排下一次，同一任务不会重叠：
 * - 普通任务：每次触发跑一轮；
 * - just_once：首次触发先停掉 cron、登记执行记录，再跑一轮；
 * - rand_cron：首次按 cron 触发后停掉 cron；此后每轮结束在 [min, max] 内均匀随机取一个
 *   时刻、向上取整到整分钟，重新注册一个只在那一分钟匹配的 Bun 原生 cron（按 UTC
 *   解释，unref），触发时同样先停掉它。
 *
 * 热重载按任务名对账（reconcileCronSchedule）：深相等的任务保留句柄（含随机时刻）；变更
 * 或删除的任务停止调度并标记撤销，在途一轮在下一个动作、重试或群之前停下；新增的任务
 * 登记。just_once 记录只在任务仍是 just_once 时保留，转为周期任务即清除；删除后同名
 * 加回仍按已执行处理。停机期间错过的触发不补发；记录与随机时刻都不持久化。
 * 所有 handler 自行吞掉异常，不向 Bun.cron 返回 reject。
 */

import { cronRuntime } from "../cache/main/cron";
import { getCronConfig } from "../config/cron";
import { CRON_JUST_ONCE_RECORD_MAX, CRON_MINUTE_MS, CRON_RANDOM_FIRE_TIME_ZONE } from "../consts/cron";
import { logger } from "../infra/logger";
import { assertTimeoutMs, drainTrackedTasks } from "../libs/inflight";
import { LruCache } from "../libs/lruCache";
import { runCronRound } from "./run";
import type { CronConfig, CronRuntime, CronTask, CronTaskSchedule } from "../types/cron";
import type { FlushResult } from "../types/lifecycle";

/** 停掉一个调度的 cron，并标记撤销。 */
function cancelSchedule(schedule: CronTaskSchedule): void {
  schedule.cancelled = true;
  schedule.job?.stop();
  schedule.job = null;
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

/**
 * 只在一个整分钟匹配的 cron 表达式：取 `instantMs` 所在或之后的第一个整分钟，按 UTC 写成
 * 「分 时 日 月 *」。表达式不含年份，调用方保证该时刻在一年之内（区间上限为
 * CRON_RANDOM_INTERVAL_MAX_MS），并在首次触发时停掉任务。
 */
function cronExpressionAt(instantMs: number): string {
  const fireAt: Date = new Date(Math.ceil(instantMs / CRON_MINUTE_MS) * CRON_MINUTE_MS);
  return `${fireAt.getUTCMinutes()} ${fireAt.getUTCHours()} ${fireAt.getUTCDate()} ${fireAt.getUTCMonth() + 1} *`;
}

/**
 * rand_cron：本轮结束后在区间内均匀随机取一个时刻，重新注册只在那一分钟触发的 Bun 原生
 * cron。实际间隔落在 [min, max + CRON_MINUTE_MS) 内。
 */
function armRandomCron(runtime: CronRuntime, schedule: CronTaskSchedule): void {
  const interval: CronTask["randomInterval"] = schedule.task.randomInterval;
  if (interval === undefined || !runtime.accepting || schedule.cancelled) return;
  const delayMs: number = interval.minMs + Math.floor(Math.random() * (interval.maxMs - interval.minMs + 1));
  schedule.job = Bun.cron(
    cronExpressionAt(Date.now() + delayMs),
    (): Promise<void> => fireCronTask(schedule),
    { tz: CRON_RANDOM_FIRE_TIME_ZONE }
  ).unref();
}

/** 一次触发（按 `cron` 表达式或 rand_cron 的随机时刻）；不抛出。 */
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
  armRandomCron(runtime, schedule);
}

/** 为一个任务注册 Bun 原生 cron。 */
function registerSchedule(task: Readonly<CronTask>): CronTaskSchedule {
  const schedule: CronTaskSchedule = { task, job: null, cancelled: false };
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

/** 停机关闭接纳并停掉全部 cron；在途轮次交给 drainCronScheduler。可重复调用。 */
export function quiesceCronScheduler(): void {
  const runtime: CronRuntime | null = cronRuntime.current;
  if (runtime === null) return;
  runtime.accepting = false;
  for (const schedule of runtime.schedules.values()) cancelSchedule(schedule);
}

/** 等待在途轮次结算；预算耗尽时取消在途请求与等待，零预算可用于紧急停机。 */
export async function drainCronScheduler(timeoutMs: number): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "Cron drain timeout");
  quiesceCronScheduler();
  const runtime: CronRuntime | null = cronRuntime.current;
  if (runtime === null) return "flushed";
  return drainTrackedTasks(runtime.runs, runtime.controller, timeoutMs);
}
