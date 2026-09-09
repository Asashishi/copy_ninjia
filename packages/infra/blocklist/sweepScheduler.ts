/**
 * 主线程黑名单补扫的唯一截止时间调度器。
 *
 * 本模块只观察补扫进度与群管理状态，不建立 claim、不投递 Worker；真正执行函数
 * 由 sweep.ts 注入，避免调度器与补扫状态机形成循环依赖。
 */

import {
  blocklistSweepSchedulerState,
  blocklistSweepState,
} from "../../cache/main/blocklist";
import { logger } from "../logger";
import { getChatStateCache } from "../storage/stateStore";
import { hasAnyBlockedIdentity } from "../identityStorage";
import { isManagedAdminChat, isSweepSlotFree } from "./sweepEligibility";
import type { ChatState } from "../../types/chatState";
import type { BlocklistSweepRunner } from "../../types/blocklist";

function clearBlocklistSweepTimer(): void {
  if (blocklistSweepSchedulerState.timer !== null) {
    clearTimeout(blocklistSweepSchedulerState.timer);
  }
  blocklistSweepSchedulerState.timer = null;
  blocklistSweepSchedulerState.scheduledAt = null;
}

function nextBlocklistSweepAt(): number | null {
  if (!hasAnyBlockedIdentity()) return null;
  let earliest: number | null = null;
  for (const [chatId, progress] of blocklistSweepState) {
    const chatState: ChatState | undefined = getChatStateCache().get(chatId);
    // 只判「槽位空不空」，不带 now：本函数要回答的正是「什么时候能扫」，
    // 退避截止时刻由下面挑最早的那一个（判据来源见 sweepEligibility.ts）。
    if (!isManagedAdminChat(chatState) || !isSweepSlotFree(progress)) {
      continue;
    }
    if (earliest === null || progress.nextRetryAt < earliest) {
      earliest = progress.nextRetryAt;
    }
  }
  return earliest;
}

/** 按所有群最近的退避截止时间重排唯一补扫 timer。 */
export function armBlocklistSweepScheduler(): void {
  const runSweep: BlocklistSweepRunner | null =
    blocklistSweepSchedulerState.runSweep;
  if (!blocklistSweepSchedulerState.accepting || runSweep === null) {
    clearBlocklistSweepTimer();
    return;
  }
  const scheduledAt: number | null = nextBlocklistSweepAt();
  if (scheduledAt === null) {
    clearBlocklistSweepTimer();
    return;
  }
  if (
    blocklistSweepSchedulerState.timer !== null &&
    blocklistSweepSchedulerState.scheduledAt === scheduledAt
  ) {
    return;
  }
  clearBlocklistSweepTimer();
  blocklistSweepSchedulerState.scheduledAt = scheduledAt;
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    // clearTimeout 与已进入事件队列的回调可能交错；陈旧回调不得清掉后来重排的
    // timer 句柄，更不能再启动一轮重复补扫。
    if (blocklistSweepSchedulerState.timer !== timer) return;
    blocklistSweepSchedulerState.timer = null;
    blocklistSweepSchedulerState.scheduledAt = null;
    void runSweep().catch((error: unknown): void => {
      logger.error("Scheduled blocklist sweep failed; retaining its retry state:", error);
    });
  }, Math.max(0, scheduledAt - Date.now()));
  timer.unref();
  blocklistSweepSchedulerState.timer = timer;
}

/** 启动恢复完成后武装补扫时钟；重复初始化只重算最近截止时间。 */
export function initBlocklistSweepScheduler(runSweep: BlocklistSweepRunner): void {
  blocklistSweepSchedulerState.runSweep = runSweep;
  blocklistSweepSchedulerState.accepting = true;
  armBlocklistSweepScheduler();
}

/** 停机前关闭补扫入口并清理 timer；既有 durable outbox 由下次启动恢复。 */
export function quiesceBlocklistSweepScheduler(): void {
  blocklistSweepSchedulerState.accepting = false;
  blocklistSweepSchedulerState.runSweep = null;
  clearBlocklistSweepTimer();
}
