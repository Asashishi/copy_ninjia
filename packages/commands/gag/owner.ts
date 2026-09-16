import { gagBackgroundTasks, gagSessionsByChat } from "../../cache/main/gag";
import { trackBackgroundTask } from "../../infra/backgroundTasks";
import type { GagSession } from "../../types/gag";

/** 在当前群的小列表中按目标 id 定位会话。 */
export function findGagSession(
  chatId: number,
  targetId: number
): GagSession | undefined {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(chatId);
  return sessions?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}

/**
 * 把一条 gag 后台任务纳入停机可观测集合并自摘除。
 *
 * 消息与 timer 触发的维护任务统一在此登记，调用方不等待 Telegram 往返。
 * 停机由 drainGagRuntime 排空；生命周期边界见 docs/cn/04-invariants.md。
 * @param failureMessage 失败时那行日志的完整英文前缀（含冒号）。
 */
export function trackGagBackgroundTask(
  task: Promise<unknown>,
  failureMessage: string
): void {
  trackBackgroundTask(gagBackgroundTasks, task, failureMessage);
}
