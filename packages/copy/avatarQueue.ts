import { avatarDrainWaiters, avatarUpdateRuntime, avatarUpdateState } from "../cache/main/copy/avatar";
import type { FlushResult } from "../types/lifecycle";
import { drainWithWaiter } from "../libs/drainWaiter";
import { logger } from "../infra/logger";
import { copyUserProfilePhoto, restoreDefaultProfilePhoto } from "../infra/telegram/avatar";
import { getBotDefaultAvatarUrl } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import type { AvatarUpdateRequest, AvatarUpdateTask } from "../types/copy/avatar";

function notifyAvatarDrainIfIdle(): void {
  if (avatarUpdateState.running || avatarUpdateState.pending !== null) return;
  for (const resolve of avatarDrainWaiters) resolve();
  avatarDrainWaiters.clear();
}

async function consumeAvatarUpdates(): Promise<void> {
  if (avatarUpdateState.running) return;
  avatarUpdateState.running = true;
  try {
    while (avatarUpdateState.pending !== null) {
      const task: AvatarUpdateTask = avatarUpdateState.pending;
      avatarUpdateState.pending = null;
      const signal: AbortSignal = avatarUpdateRuntime.controller.signal;
      if (signal.aborted) break;
      try {
        // 偷脸与复原共用这一个执行槽：两者抢的是同一份「换头像」限流资源，
        // 分开跑只会让 Telegram 两边都限流。latest-only 语义也因此对两类目标
        // 通用——连点 /steal_icon 再 /reset_icon，最终生效的是最后那个。
        // 默认头像的直链在这里取：state 内存只属于主线程，而 avatar/restore.ts
        // 被两条 Worker 一并 import（见 stateStore.ts 的 getBotDefaultAvatarUrl）。
        const updated: boolean = task.target.kind === "default"
          ? await restoreDefaultProfilePhoto(getBotDefaultAvatarUrl(), signal)
          : await copyUserProfilePhoto(
            task.target.user.id,
            !!task.target.user.isChannel,
            { username: task.target.user.username, signal }
          );
        // 在途任务不能取消，但新目标到达后旧战报已经过期；最终只让最新目标
        // 报告结果，随后单一执行槽继续处理最新 pending。
        if (!signal.aborted && task.generation === avatarUpdateState.latestGeneration) {
          await sendCommandMessage({
            chatId: task.chatId,
            text: updated ? task.successText : task.failureText,
            signal,
          });
        }
      } catch (error: unknown) {
        if (signal.aborted) break;
        logger.error("Error in background avatar update task:", error);
      }
    }
  } finally {
    avatarUpdateState.running = false;
    notifyAvatarDrainIfIdle();
    // 防御微任务交界：若 finally 前后刚好有新值到达，重新取得唯一执行槽。
    if (avatarUpdateState.pending !== null) void consumeAvatarUpdates();
  }
}

/** 提交头像目标；运行中只保留最新一份，历史请求不会形成 Promise 链。 */
export function queueAvatarUpdate(request: AvatarUpdateRequest): void {
  if (!avatarUpdateRuntime.accepting) return;
  const generation: number = avatarUpdateState.nextGeneration++;
  avatarUpdateState.latestGeneration = generation;
  avatarUpdateState.pending = { ...request, generation };
  void consumeAvatarUpdates();
}

/** 生命周期边界：等待当前执行槽和 latest-only 待执行槽归零。 */
export function drainAvatarUpdates(timeoutMs: number): Promise<FlushResult> {
  return drainWithWaiter({
    owner: "Avatar",
    timeoutMs,
    isIdle: (): boolean => !avatarUpdateState.running && avatarUpdateState.pending === null,
    waiters: avatarDrainWaiters,
    notifyIfIdle: notifyAvatarDrainIfIdle,
    abort: abortAvatarUpdates,
  });
}

export function initAvatarUpdates(): void {
  if (avatarUpdateState.running) throw new Error("Cannot initialize avatar updates while a task is active.");
  avatarUpdateState.pending = null;
  avatarUpdateRuntime.controller = new AbortController();
  avatarUpdateRuntime.accepting = true;
}

export function quiesceAvatarUpdates(): void {
  avatarUpdateRuntime.accepting = false;
}

function abortAvatarUpdates(): void {
  avatarUpdateRuntime.accepting = false;
  avatarUpdateState.pending = null;
  avatarUpdateState.latestGeneration = avatarUpdateState.nextGeneration++;
  if (!avatarUpdateRuntime.controller.signal.aborted) avatarUpdateRuntime.controller.abort();
  notifyAvatarDrainIfIdle();
}
