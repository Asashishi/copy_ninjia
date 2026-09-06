import { wedChats, wedRuntime } from "../../cache/main/wed";
import { WED_MAX_CONCURRENT, WED_MAX_PENDING } from "../../consts/wed";
import { trackBackgroundTask } from "../../infra/backgroundTasks";
import { combineWithUpdateAbortSignal, runWithUpdateAbortSignal } from "../../infra/updateContext";
import { settleWithinBudget } from "../../libs/inflight";
import { createPrioritizedBoundedTaskRunner } from "../../libs/prioritizedBoundedTaskRunner";
import type { FlushResult } from "../../types/lifecycle";
import type { WedChat, WedRuntime } from "../../types/wed";
import { resetWedMemberStates } from "../../cache/main/wedMembers";
import { flushWedMembers } from "./persistence";

/** 启动时创建唯一执行器；上一代还有任务时禁止重建。 */
export function initWedRuntime(): void {
  const previous: WedRuntime | null = wedRuntime.current;
  if (previous !== null && previous.tasks.size > 0) {
    throw new Error("Cannot initialize wed while tasks are unsettled.");
  }
  previous?.controller.abort();
  for (const chat of wedChats.values()) chat.controller.abort();
  wedChats.clear();
  resetWedMemberStates();
  wedRuntime.current = {
    runner: createPrioritizedBoundedTaskRunner({
      maxConcurrent: WED_MAX_CONCURRENT,
      maxPending: WED_MAX_PENDING,
      maxBackgroundPending: 0,
      interactiveBurst: 1,
    }),
    controller: new AbortController(),
    tasks: new Set(),
    accepting: true,
  };
}

/**
 * 同步接纳纯内存交互，执行槽覆盖完整查询、下载和 Telegram 出站等待。
 * 每项恢复自己接纳时的取消上下文，不能继承释放槽位的另一条任务的上下文。
 * 群取消只撤销未开始任务；在途会话由 teardown 取消并沿原边界清理迟到图片。
 * @see ../../../docs/cn/04-invariants.md
 */
export function submitWedTask(chat: WedChat, task: () => Promise<unknown>): boolean {
  const runtime: WedRuntime | null = wedRuntime.current;
  if (runtime === null || !runtime.accepting || chat.controller.signal.aborted ||
    runtime.runner.pendingCount >= WED_MAX_PENDING) return false;
  const taskSignal: AbortSignal = combineWithUpdateAbortSignal(runtime.controller.signal)!;
  if (taskSignal.aborted) return false;
  const queuedSignal: AbortSignal = AbortSignal.any([taskSignal, chat.controller.signal]);
  const completion: Promise<unknown> = runtime.runner.run("interactive", (): Promise<unknown> =>
    runWithUpdateAbortSignal(taskSignal, task), queuedSignal).catch((error: unknown): void => {
    if (!taskSignal.aborted) throw error;
  });
  trackBackgroundTask(runtime.tasks, completion, "Unexpected error while processing wed interaction:");
  return true;
}

/** 停机关闭接纳；已经接纳的任务仍在原执行器中按序排空。 */
export function quiesceWedRuntime(): void {
  if (wedRuntime.current !== null) wedRuntime.current.accepting = false;
}

/** 等待已接纳交互全部结算；预算耗尽时取消排队和在途请求，零预算可用于紧急停机。 */
export async function drainWedRuntime(timeoutMs: number): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Wed drain timeout must be finite and non-negative.");
  quiesceWedRuntime();
  const runtime: WedRuntime | null = wedRuntime.current;
  if (runtime === null || runtime.tasks.size === 0) return flushWedMembers() ? "flushed" : "failed";
  if (timeoutMs > 0 && await settleWithinBudget(runtime.tasks, timeoutMs)) return flushWedMembers() ? "flushed" : "failed";
  runtime.controller.abort();
  flushWedMembers();
  return "timedOut";
}
