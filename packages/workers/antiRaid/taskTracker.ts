import {
  antiRaidInFlightTasks,
  antiRaidTaskTrackerGeneration,
} from "../../cache/antiRaid/tasks";
import {
  blocklistRemovalEpochs,
  blocklistRemovalTaskCounts,
} from "../../cache/antiRaid/blocklist";

/**
 * Anti-Raid Worker 的异步副作用登记与停机排空。
 *
 * mailbox handler 仍保持同步，不让网络往返阻塞后续状态转移；每个后台
 * Promise 同时登记到这里，真正停机时才等待它们结算。
 */

export interface TrackAntiRaidTaskParams<T> {
  task: Promise<T>;
  /** 仅黑名单处置填写；用于在最后一项 settle 后安全回收取消世代。 */
  blocklistChatId?: number;
}

/** 登记一项异步副作用，并原样返回调用方的 Promise。 */
export function trackAntiRaidTask<T>({
  task,
  blocklistChatId,
}: TrackAntiRaidTaskParams<T>): Promise<T> {
  if (antiRaidInFlightTasks.has(task)) return task;
  const generation: number = antiRaidTaskTrackerGeneration.current;
  antiRaidInFlightTasks.add(task);
  if (blocklistChatId !== undefined) {
    blocklistRemovalTaskCounts.set(
      blocklistChatId,
      (blocklistRemovalTaskCounts.get(blocklistChatId) ?? 0) + 1
    );
  }

  const settle: () => void = (): void => {
    if (antiRaidTaskTrackerGeneration.current !== generation) return;
    antiRaidInFlightTasks.delete(task);
    if (blocklistChatId === undefined) return;
    const remaining: number = (blocklistRemovalTaskCounts.get(blocklistChatId) ?? 1) - 1;
    if (remaining > 0) {
      blocklistRemovalTaskCounts.set(blocklistChatId, remaining);
      return;
    }
    blocklistRemovalTaskCounts.delete(blocklistChatId);
    blocklistRemovalEpochs.delete(blocklistChatId);
  };
  void task.then(settle, settle);
  return task;
}

/**
 * 等待当前及其结算过程中派生的异步任务全部结束。新 Telegram updates 已由
 * 主线程 runner 在调用本函数前停止；timer 状态仍由持久化镜像负责重建。
 */
export async function drainAntiRaidTasks(): Promise<void> {
  while (antiRaidInFlightTasks.size > 0) {
    await Promise.allSettled([...antiRaidInFlightTasks]);
  }
}

/** Worker stop/测试隔离时清空 tracker；旧任务迟到结算由 generation 拒绝。 */
export function resetAntiRaidTaskTracker(): void {
  antiRaidTaskTrackerGeneration.current++;
  antiRaidInFlightTasks.clear();
  blocklistRemovalTaskCounts.clear();
  blocklistRemovalEpochs.clear();
}
