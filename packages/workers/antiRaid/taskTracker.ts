import {
  antiRaidDispatchAbort,
  antiRaidInFlightTasks,
  antiRaidTaskTrackerGeneration,
} from "../../cache/workers/antiRaid/tasks";
import {
  blocklistRemovalEpochs,
  blocklistRemovalTaskCounts,
} from "../../cache/workers/antiRaid/blocklist";

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
 * 排队时长可能远超 drain 预算的那些尽力而为请求共用的取消信号。
 *
 * 停机之后取到的是一个已经 abort 的信号，因此这类请求在 drain 之后不再排队，
 * 而是立刻结算成失败——契约与用法见 cache/workers/antiRaid/tasks.ts 的
 * antiRaidDispatchAbort。
 */
export function antiRaidDispatchSignal(): AbortSignal {
  antiRaidDispatchAbort.current ??= new AbortController();
  return antiRaidDispatchAbort.current.signal;
}

/**
 * drain 到达：撤掉所有还在消息桶或分类型 429 车道里等待的尽力而为请求。
 *
 * 必须排在 drainAntiRaidTasks 之前，且**必须**在统一延迟删除 flush 之前——
 * 后者是 drain 期间刻意新建的请求，不能让它误用已经取消的业务生命周期。
 */
export function quiesceAntiRaidDispatch(): void {
  antiRaidDispatchAbort.current ??= new AbortController();
  antiRaidDispatchAbort.current.abort(
    new DOMException("Anti-Raid worker is draining.", "AbortError")
  );
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
  // 换一个没被 abort 的控制器：停机用的那个一旦 abort 就永久 abort，留着会让
  // 下一次 start（以及每个测试用例）发出的请求当场失败。
  antiRaidDispatchAbort.current = null;
  blocklistRemovalTaskCounts.clear();
  blocklistRemovalEpochs.clear();
}
