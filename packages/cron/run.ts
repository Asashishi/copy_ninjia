/**
 * cron 任务的一轮：按顺序投递全部动作，相邻动作间隔 CRON_ACTION_GAP_MS。
 *
 * 每个动作最多一次尝试加 CRON_ACTION_RETRY_DELAYS_MS 那么多次重试；可重试的失败是网络
 * 错误、5xx、出站队列满，以及出站闸按 retry_after 退避后仍被挡住的 429，四者都计入本动作
 * 的重试次数，其余 4xx 与本地错误不重试。最终失败记一行英文错误日志并中止这个会话剩余的
 * 动作。任务被热重载撤销或停机时，当前请求不打断，在下一个动作、下一次重试，或目标解析与
 * 投递的下一个群之前停下；停机超时由 signal 取消在途请求与等待。
 *
 * `chat_id` 逐个列出会话时按书写顺序投递，不查发送权限；`["all"]` 与 `["except", ...]`
 * 先解析本轮的可发送群（cron/targets.ts），再按 chat id 升序逐群执行整套动作。两种写法
 * 下会话与会话之间同样间隔 CRON_ACTION_GAP_MS；一个会话的失败只中止该会话剩余的动作，
 * 随后继续下一个会话。每轮新建一张 CronRoundVoices，`send_voice` 在本轮只合成一次，
 * 首次发送成功后改用 Telegram 交回的 file_id、不再上传，重试与各会话共用；轮次结束即丢弃。
 */

import { CRON_ACTION_GAP_MS, CRON_ACTION_RETRY_DELAYS_MS, CRON_NO_EXCLUDED_CHAT_IDS } from "../consts/cron";
import { logger } from "../infra/logger";
import { sleep } from "../libs/sleep";
import { deliverCronAction } from "./delivery";
import { resolveCronGroupTargets } from "./targets";
import type {
  CronAction,
  CronChatTargets,
  CronDeliveryOutcome,
  CronGroupTargets,
  CronRoundVoices,
  CronTaskSchedule,
} from "../types/cron";

/** 一轮共用的上下文；每轮建一次。 */
interface CronRoundContext {
  readonly schedule: CronTaskSchedule;
  readonly signal: AbortSignal;
  readonly voices: CronRoundVoices;
}

/** 向一个会话投递所需的上下文；每个会话建一次，动作与重试共用。 */
interface CronDeliveryContext extends CronRoundContext {
  readonly chatId: number;
  /** 本轮投递多个会话；日志据此写明是哪个会话。 */
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
  { schedule, chatId, signal, voices }: CronDeliveryContext,
  action: Readonly<CronAction>
): Promise<CronActionResult> {
  for (let attempt: number = 0; ; attempt++) {
    if (isStopped(schedule, signal)) return { kind: "stopped" };
    const outcome: CronDeliveryOutcome = await deliverCronAction({ chatId, action, signal, voices });
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

/**
 * 按会话顺序逐个执行整套动作；返回 false 表示本轮已被撤销或取消。
 *
 * 只有「逐个列出的单个会话」按整轮口径记日志；`["all"]`、`["except", ...]` 与列出多个
 * 会话时，失败日志一律写明是哪个会话——前两种本轮解析出几个群不固定，日志口径不能跟着变。
 */
async function runChats(round: CronRoundContext, chatIds: readonly number[]): Promise<boolean> {
  const { schedule, signal, voices }: CronRoundContext = round;
  const chatTargets: CronChatTargets = schedule.task.chatTargets;
  const perChat: boolean = chatTargets.kind !== "list" || chatIds.length > 1;
  for (let index: number = 0; index < chatIds.length; index++) {
    if (isStopped(schedule, signal)) return false;
    if (index > 0 && !await pause(CRON_ACTION_GAP_MS, signal)) return false;
    if (!await runActions({ schedule, signal, voices, chatId: chatIds[index]!, perChat })) return false;
  }
  return true;
}

/** 执行一个任务的一轮；不抛出。 */
export async function runCronRound(schedule: CronTaskSchedule, signal: AbortSignal): Promise<void> {
  const round: CronRoundContext = { schedule, signal, voices: new Map() };
  const chatTargets: CronChatTargets = schedule.task.chatTargets;
  if (chatTargets.kind === "list") {
    await runChats(round, chatTargets.chatIds);
    return;
  }
  const targets: CronGroupTargets = await resolveCronGroupTargets(
    schedule,
    chatTargets.kind === "except" ? chatTargets.chatIds : CRON_NO_EXCLUDED_CHAT_IDS,
    signal
  );
  if (!await runChats(round, targets.chatIds)) return;
  if (targets.skipped > 0) {
    logger.log(`Cron task "${schedule.task.name}" skipped ${targets.skipped} chat(s) without send permission.`);
  }
}
