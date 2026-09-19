/**
 * cron 任务的一轮：按顺序投递全部动作，相邻动作间隔 CRON_ACTION_GAP_MS。
 *
 * 每个动作最多一次尝试加 CRON_ACTION_RETRY_DELAYS_MS 那么多次重试；只有可重试的失败
 * （网络、5xx、出站队列满）才退避重试，429 由出站闸自己按 retry_after 退避、不计次。
 * 最终失败记一行英文错误日志并中止本轮剩余动作。任务被热重载撤销或停机时，当前
 * 请求不打断，在下一个动作或下一次重试之前停下；停机超时由 signal 取消在途请求与等待。
 */

import { CRON_ACTION_GAP_MS, CRON_ACTION_RETRY_DELAYS_MS } from "../consts/cron";
import { logger } from "../infra/logger";
import { sleep } from "../libs/sleep";
import { deliverCronAction } from "./delivery";
import type { CronAction, CronDeliveryOutcome, CronTaskSchedule } from "../types/cron";

/** 一个动作连同重试的最终结果。 */
type CronActionResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly attempts: number; readonly detail: string };

/** 调度已撤销或本轮已被取消。 */
function isStopped(schedule: CronTaskSchedule, signal: AbortSignal): boolean {
  return schedule.cancelled || signal.aborted;
}

/** 等待一段时间；被取消时返回 false，不抛出。 */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return true;
  } catch {
    return false;
  }
}

/** 投递一个动作，按分类重试。 */
async function deliverWithRetries(
  schedule: CronTaskSchedule,
  action: Readonly<CronAction>,
  signal: AbortSignal
): Promise<CronActionResult> {
  for (let attempt: number = 0; ; attempt++) {
    if (isStopped(schedule, signal)) return { kind: "stopped" };
    const outcome: CronDeliveryOutcome = await deliverCronAction(schedule.task, action, signal);
    if (outcome.kind === "sent") return { kind: "delivered" };
    if (outcome.kind === "aborted") return { kind: "stopped" };
    const delay: number | undefined = CRON_ACTION_RETRY_DELAYS_MS[attempt];
    if (outcome.kind === "permanent" || delay === undefined) {
      return { kind: "failed", attempts: attempt + 1, detail: outcome.detail };
    }
    if (!await pause(delay, signal)) return { kind: "stopped" };
  }
}

/** 执行一个任务的一轮；不抛出。 */
export async function runCronRound(schedule: CronTaskSchedule, signal: AbortSignal): Promise<void> {
  const actions: readonly Readonly<CronAction>[] = schedule.task.actions;
  for (let index: number = 0; index < actions.length; index++) {
    if (index > 0 && !await pause(CRON_ACTION_GAP_MS, signal)) return;
    const action: Readonly<CronAction> = actions[index]!;
    const result: CronActionResult = await deliverWithRetries(schedule, action, signal);
    if (result.kind === "stopped") return;
    if (result.kind === "failed") {
      logger.error(
        `Cron task "${schedule.task.name}" action #${index + 1} (${action.type}) failed after ` +
        `${result.attempts} attempt(s); skipping the remaining actions of this run: ${result.detail}`
      );
      return;
    }
  }
}
