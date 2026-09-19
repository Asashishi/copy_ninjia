/**
 * cron 任务的一轮：按顺序投递全部动作，相邻动作间隔 CRON_ACTION_GAP_MS。
 *
 * 每个动作最多一次尝试加 CRON_ACTION_RETRY_DELAYS_MS 那么多次重试；只有可重试的失败
 * （网络、5xx、出站队列满）才退避重试，429 由出站闸自己按 retry_after 退避、不计次。
 * 最终失败记一行英文错误日志并中止这个会话剩余的动作。任务被热重载撤销或停机时，当前
 * 请求不打断，在下一个动作、下一次重试或下一个群之前停下；停机超时由 signal 取消在途
 * 请求与等待。
 *
 * `chat_id: "all"` 的任务先解析本轮的可发送群（cron/targets.ts），再按 chat id 升序逐群
 * 执行整套动作，群与群之间同样间隔 CRON_ACTION_GAP_MS；一个群的失败只中止该群剩余的
 * 动作，随后继续下一个群。
 */

import { CRON_ACTION_GAP_MS, CRON_ACTION_RETRY_DELAYS_MS, CRON_ALL_CHATS } from "../consts/cron";
import { logger } from "../infra/logger";
import { sleep } from "../libs/sleep";
import { deliverCronAction } from "./delivery";
import { resolveCronGroupTargets } from "./targets";
import type { CronAction, CronAllChats, CronDeliveryOutcome, CronGroupTargets, CronTaskSchedule } from "../types/cron";

/** 向一个会话投递所需的上下文；每个会话建一次，动作与重试共用。 */
interface CronDeliveryContext {
  readonly schedule: CronTaskSchedule;
  readonly chatId: number;
  readonly signal: AbortSignal;
  /** 是否为 `chat_id: "all"` 的逐群投递；日志据此写明是哪个群。 */
  readonly perChat: boolean;
}

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

/** 向一个会话投递一个动作，按分类重试。 */
async function deliverWithRetries(
  { schedule, chatId, signal }: CronDeliveryContext,
  action: Readonly<CronAction>
): Promise<CronActionResult> {
  for (let attempt: number = 0; ; attempt++) {
    if (isStopped(schedule, signal)) return { kind: "stopped" };
    const outcome: CronDeliveryOutcome = await deliverCronAction(chatId, action, signal);
    if (outcome.kind === "sent") return { kind: "delivered" };
    if (outcome.kind === "aborted") return { kind: "stopped" };
    const delay: number | undefined = CRON_ACTION_RETRY_DELAYS_MS[attempt];
    if (outcome.kind === "permanent" || delay === undefined) {
      return { kind: "failed", attempts: attempt + 1, detail: outcome.detail };
    }
    if (!await pause(delay, signal)) return { kind: "stopped" };
  }
}

/**
 * 向一个会话顺序投递全部动作。失败记一行日志并中止该会话剩余的动作；返回 false 表示
 * 本轮已被撤销或取消，调用方应整轮收场。
 */
async function runActions(context: CronDeliveryContext): Promise<boolean> {
  const { schedule, chatId, signal, perChat }: CronDeliveryContext = context;
  const actions: readonly Readonly<CronAction>[] = schedule.task.actions;
  for (let index: number = 0; index < actions.length; index++) {
    if (index > 0 && !await pause(CRON_ACTION_GAP_MS, signal)) return false;
    const action: Readonly<CronAction> = actions[index]!;
    const result: CronActionResult = await deliverWithRetries(context, action);
    if (result.kind === "stopped") return false;
    if (result.kind === "failed") {
      logger.error(perChat
        ? `Cron task "${schedule.task.name}" action #${index + 1} (${action.type}) failed in chat ${chatId} ` +
          `after ${result.attempts} attempt(s); skipping the remaining actions for this chat: ${result.detail}`
        : `Cron task "${schedule.task.name}" action #${index + 1} (${action.type}) failed after ` +
          `${result.attempts} attempt(s); skipping the remaining actions of this run: ${result.detail}`);
      return true;
    }
  }
  return true;
}

/** 执行一个任务的一轮；不抛出。 */
export async function runCronRound(schedule: CronTaskSchedule, signal: AbortSignal): Promise<void> {
  const chatId: number | CronAllChats = schedule.task.chatId;
  if (chatId !== CRON_ALL_CHATS) {
    await runActions({ schedule, chatId, signal, perChat: false });
    return;
  }
  const targets: CronGroupTargets = await resolveCronGroupTargets(schedule.task, signal);
  for (let index: number = 0; index < targets.chatIds.length; index++) {
    if (isStopped(schedule, signal)) return;
    if (index > 0 && !await pause(CRON_ACTION_GAP_MS, signal)) return;
    if (!await runActions({ schedule, chatId: targets.chatIds[index]!, signal, perChat: true })) return;
  }
  if (targets.skipped > 0) {
    logger.log(`Cron task "${schedule.task.name}" skipped ${targets.skipped} chat(s) without send permission.`);
  }
}
