/**
 * 延迟命令执行器：要等目录枚举、下载或上传的命令任务（`/h_image` 抽图与收图、`/info`）
 * 的共同接纳、停机与排空边界，状态见 cache/main/deferredCommands.ts。
 *
 * update runner 严格串行（见 docs/cn/04-invariants.md），这些 handler 在参数校验后同步
 * 交给本执行器即返回，照 `/wed` 的接纳方式恢复接纳时的 update 取消上下文并合入运行时
 * 停止信号。交互请求走 interactive 档；批量收图走 background 档，两档都有等待项时按
 * interactiveBurst 轮流取。
 */

import { deferredCommandRuntime } from "../cache/main/deferredCommands";
import {
  DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
  DEFERRED_COMMAND_MAX_CONCURRENT,
  DEFERRED_COMMAND_MAX_PENDING,
} from "../consts/deferredCommands";
import { trackBackgroundTask } from "../infra/backgroundTasks";
import { combineWithUpdateAbortSignal, runWithUpdateAbortSignal } from "../infra/updateContext";
import { settleWithinBudget } from "../libs/inflight";
import { createPrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { TaskPriority } from "../libs/prioritizedBoundedTaskRunner";
import type { DeferredCommandRuntime } from "../types/deferredCommands";
import type { FlushResult } from "../types/lifecycle";

/**
 * 同步接纳一个命令任务；执行器未启动、已停止接纳或该档等待位已满时返回 false，调用方
 * 回「稍后再试」。任务在自己的 update 取消上下文里运行，停机取消后的异常不再上报。
 * @param errorLabel 任务意外抛错时写进错误日志的英文前缀。
 */
export function submitDeferredCommand(
  priority: TaskPriority,
  task: () => Promise<void>,
  errorLabel: string
): boolean {
  const runtime: DeferredCommandRuntime | null = deferredCommandRuntime.current;
  if (runtime === null || !runtime.accepting || runtime.runner.pendingCount >= DEFERRED_COMMAND_MAX_PENDING) return false;
  if (priority === "background" && runtime.runner.backgroundPendingCount >= DEFERRED_COMMAND_MAX_BACKGROUND_PENDING) return false;
  const taskSignal: AbortSignal = combineWithUpdateAbortSignal(runtime.controller.signal)!;
  if (taskSignal.aborted) return false;
  const completion: Promise<unknown> = runtime.runner.run(priority, (): Promise<void> =>
    runWithUpdateAbortSignal(taskSignal, task), taskSignal)
    .catch((error: unknown): void => {
      if (!taskSignal.aborted) throw error;
    });
  trackBackgroundTask(runtime.tasks, completion, errorLabel);
  return true;
}

/** 启动时创建唯一执行器；上一代还有任务时禁止重建。 */
export function initDeferredCommandRuntime(): void {
  const previous: DeferredCommandRuntime | null = deferredCommandRuntime.current;
  if (previous !== null && previous.tasks.size > 0) {
    throw new Error("Cannot initialize deferred commands while tasks are unsettled.");
  }
  previous?.controller.abort();
  deferredCommandRuntime.current = {
    runner: createPrioritizedBoundedTaskRunner({
      maxConcurrent: DEFERRED_COMMAND_MAX_CONCURRENT,
      maxPending: DEFERRED_COMMAND_MAX_PENDING,
      maxBackgroundPending: DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
      interactiveBurst: 1,
    }),
    controller: new AbortController(),
    tasks: new Set(),
    accepting: true,
  };
}

/** 停机关闭接纳；已接纳的任务仍在原执行器中按序排空。 */
export function quiesceDeferredCommandRuntime(): void {
  if (deferredCommandRuntime.current !== null) deferredCommandRuntime.current.accepting = false;
}

/** 等待已接纳的任务结算；预算耗尽时取消排队与在途任务，零预算可用于紧急停机。 */
export async function drainDeferredCommandRuntime(timeoutMs: number): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Deferred command drain timeout must be finite and non-negative.");
  quiesceDeferredCommandRuntime();
  const runtime: DeferredCommandRuntime | null = deferredCommandRuntime.current;
  if (runtime === null || runtime.tasks.size === 0) return "flushed";
  if (timeoutMs > 0 && await settleWithinBudget(runtime.tasks, timeoutMs)) return "flushed";
  runtime.controller.abort();
  return "timedOut";
}
