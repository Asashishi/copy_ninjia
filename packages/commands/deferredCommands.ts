/**
 * 延迟命令执行器：要等目录枚举、下载、上传、语音合成或批量 Telegram 请求的命令任务
 * （`/h_image` 抽图与收图、`/info`、`/send` 的 TTS 代发、`/batch_kick` 的批次、`/block enable` 的
 * 跨群封禁）的共同接纳、停机与排空边界，状态见 cache/main/deferredCommands.ts。
 *
 * update runner 严格串行（见 docs/cn/04-invariants.md），这些 handler 在参数校验后同步
 * 交给本执行器即返回；任务经 infra/commandExecutor.ts 的 submitCommandExecutorTask 恢复
 * 接纳时的 update 取消上下文并合入运行时停止信号。交互请求走 interactive 档；批量收图、
 * `/batch_kick` 与 `/block enable` 的跨群封禁走 background 档，两档都有等待项时按 interactiveBurst 轮流取。
 */

import { deferredCommandRuntime } from "../cache/main/deferredCommands";
import {
  DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
  DEFERRED_COMMAND_MAX_CONCURRENT,
  DEFERRED_COMMAND_MAX_PENDING,
} from "../consts/deferredCommands";
import { createCommandExecutorRuntime, submitCommandExecutorTask } from "../infra/commandExecutor";
import { assertTimeoutMs, drainTrackedTasks } from "../libs/inflight";
import type { TaskPriority } from "../libs/prioritizedBoundedTaskRunner";
import type { CommandExecutorRuntime } from "../types/commandExecutor";
import type { FlushResult } from "../types/lifecycle";

/** submitDeferredCommand 的入参。 */
export interface SubmitDeferredCommandOptions {
  readonly priority: TaskPriority;
  readonly task: () => Promise<void>;
  /** 任务意外抛错时写进错误日志的英文前缀。 */
  readonly errorLabel: string;
  /** 已接纳的任务没有开跑就被停机或 update 取消撤销时调用一次。 */
  readonly onSkipped?: () => void;
}

/**
 * 同步接纳一个命令任务；执行器未启动、已停止接纳或该档等待位已满时返回 false，调用方
 * 回「稍后再试」或就地执行（commands/blocklistFanOut.ts）。任务在自己的 update 取消上下文里
 * 运行，停机取消后的异常不再上报。
 */
export function submitDeferredCommand({
  priority,
  task,
  errorLabel,
  onSkipped,
}: SubmitDeferredCommandOptions): boolean {
  const runtime: CommandExecutorRuntime | null = deferredCommandRuntime.current;
  if (runtime === null || !runtime.accepting || runtime.runner.pendingCount >= DEFERRED_COMMAND_MAX_PENDING) return false;
  if (priority === "background" && runtime.runner.backgroundPendingCount >= DEFERRED_COMMAND_MAX_BACKGROUND_PENDING) return false;
  return submitCommandExecutorTask({ runtime, priority, task, errorLabel, onSkipped });
}

/** 启动时创建唯一执行器；上一代还有任务时禁止重建。 */
export function initDeferredCommandRuntime(): void {
  const previous: CommandExecutorRuntime | null = deferredCommandRuntime.current;
  if (previous !== null && previous.tasks.size > 0) {
    throw new Error("Cannot initialize deferred commands while tasks are unsettled.");
  }
  previous?.controller.abort();
  deferredCommandRuntime.current = createCommandExecutorRuntime({
    maxConcurrent: DEFERRED_COMMAND_MAX_CONCURRENT,
    maxPending: DEFERRED_COMMAND_MAX_PENDING,
    maxBackgroundPending: DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
    interactiveBurst: 1,
  });
}

/** 停机关闭接纳；已接纳的任务仍在原执行器中按序排空。 */
export function quiesceDeferredCommandRuntime(): void {
  if (deferredCommandRuntime.current !== null) deferredCommandRuntime.current.accepting = false;
}

/** 等待已接纳的任务结算；预算耗尽时取消排队与在途任务，零预算可用于紧急停机。 */
export async function drainDeferredCommandRuntime(timeoutMs: number): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "Deferred command drain timeout");
  quiesceDeferredCommandRuntime();
  const runtime: CommandExecutorRuntime | null = deferredCommandRuntime.current;
  if (runtime === null) return "flushed";
  return drainTrackedTasks(runtime.tasks, runtime.controller, timeoutMs);
}
