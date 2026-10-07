import { wedAvatarProbes, wedChats, wedRuntime } from "../../cache/main/wed";
import { WED_MAX_CONCURRENT, WED_MAX_PENDING } from "../../consts/wed";
import { createCommandExecutorRuntime, submitCommandExecutorTask } from "../../infra/commandExecutor";
import { assertTimeoutMs, drainTrackedTasks } from "../../libs/inflight";
import type { CommandExecutorRuntime } from "../../types/commandExecutor";
import type { FlushResult } from "../../types/lifecycle";
import type { WedChat } from "../../types/wed";
import { resetWedMemberStates } from "../../cache/main/wedMembers";
import { flushWedMembers } from "./persistence";
import { initWedMemberReview, stopWedMemberReview } from "./memberReview";

/** 启动时创建唯一执行器并清空旧探测；上一代还有任务时禁止重建。 */
export function initWedRuntime(): void {
  const previous: CommandExecutorRuntime | null = wedRuntime.current;
  if (previous !== null && previous.tasks.size > 0) {
    throw new Error("Cannot initialize wed while tasks are unsettled.");
  }
  previous?.controller.abort();
  initWedMemberReview();
  for (const [, chat] of wedChats) chat.controller.abort();
  wedChats.clear();
  wedAvatarProbes.clear();
  resetWedMemberStates();
  wedRuntime.current = createCommandExecutorRuntime({
    maxConcurrent: WED_MAX_CONCURRENT,
    maxPending: WED_MAX_PENDING,
    maxBackgroundPending: 0,
    interactiveBurst: 1,
  });
}

/**
 * 同步接纳纯内存交互，执行槽覆盖完整查询、下载和 Telegram 出站等待。
 * 每项恢复自己接纳时的取消上下文，不继承释放槽位的另一条任务的上下文。
 * 群取消只撤销未开始任务；在途会话由 teardown 取消并沿原边界清理迟到图片。
 * @see ../../../docs/cn/04-invariants.md
 */
export function submitWedTask(chat: WedChat, task: () => Promise<unknown>): boolean {
  const runtime: CommandExecutorRuntime | null = wedRuntime.current;
  if (runtime === null || !runtime.accepting || chat.controller.signal.aborted ||
    runtime.runner.pendingCount >= WED_MAX_PENDING) return false;
  return submitCommandExecutorTask({
    runtime,
    priority: "interactive",
    task,
    errorLabel: "Unexpected error while processing wed interaction:",
    queueSignal: chat.controller.signal,
  });
}

/** 停机关闭接纳并取消成员复核；已接纳的交互仍在原执行器中按序排空。 */
export function quiesceWedRuntime(): void {
  if (wedRuntime.current !== null) wedRuntime.current.accepting = false;
  stopWedMemberReview();
}

/** 等待交互与成员复核结算；预算耗尽时取消排队和在途请求，零预算可用于紧急停机。 */
export async function drainWedRuntime(timeoutMs: number): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "Wed drain timeout");
  quiesceWedRuntime();
  const runtime: CommandExecutorRuntime | null = wedRuntime.current;
  const drained: "flushed" | "timedOut" = runtime === null
    ? "flushed"
    : await drainTrackedTasks(runtime.tasks, runtime.controller, timeoutMs);
  if (drained === "timedOut") {
    flushWedMembers();
    return "timedOut";
  }
  return flushWedMembers() ? "flushed" : "failed";
}
