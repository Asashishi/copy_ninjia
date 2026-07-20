import { avatarDrainWaiters, avatarUpdateState } from "../cache/copy/avatar";
import type { FlushResult } from "../consts/lifecycle";
import { logger } from "../infra/logger";
import { copyUserProfilePhoto } from "../infra/telegram/avatar";
import { sendMessage } from "../infra/telegram/actions";
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
      try {
        const updated: boolean = await copyUserProfilePhoto(
          task.target.id,
          !!task.target.isChannel,
          task.target.username
        );
        // 在途任务不能取消，但新目标到达后旧战报已经过期；最终只让最新目标
        // 报告结果，随后单一执行槽继续处理最新 pending。
        if (task.generation === avatarUpdateState.latestGeneration) {
          await sendMessage({ chatId: task.chatId, text: updated ? task.successText : task.failureText });
        }
      } catch (error: unknown) {
        logger.error("Error in background avatar steal task:", error);
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
  const generation: number = avatarUpdateState.nextGeneration++;
  avatarUpdateState.latestGeneration = generation;
  avatarUpdateState.pending = { ...request, generation };
  void consumeAvatarUpdates();
}

/** 生命周期边界：等待当前执行槽和 latest-only 待执行槽归零。 */
export function drainAvatarUpdates(timeoutMs: number): Promise<FlushResult> {
  if (!avatarUpdateState.running && avatarUpdateState.pending === null) return Promise.resolve("flushed");
  if (timeoutMs <= 0) return Promise.resolve("timedOut");
  return new Promise((resolve) => {
    let settled: boolean = false;
    function finish(result: FlushResult): void {
      if (settled) return;
      settled = true;
      avatarDrainWaiters.delete(onIdle);
      clearTimeout(timer);
      resolve(result);
    }
    const onIdle = (): void => finish("flushed");
    const timer = setTimeout(() => finish("timedOut"), timeoutMs);
    avatarDrainWaiters.add(onIdle);
    notifyAvatarDrainIfIdle();
  });
}
