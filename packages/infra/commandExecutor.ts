/**
 * 主线程命令执行器的共同部分：建一代运行状态，以及按接纳时的 update 取消上下文提交任务。
 * `/wed`（commands/wed/runtime.ts）与延迟命令（commands/deferredCommands.ts）各持一份运行
 * 状态；接纳前的开关与容量判定、停机与排空由各自调用方负责。
 */

import { trackBackgroundTask } from "./backgroundTasks";
import { combineWithUpdateAbortSignal, currentUpdateTopic, runWithUpdateAbortSignal } from "./updateContext";
import { createPrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type {
  PrioritizedBoundedTaskRunnerOptions,
  TaskPriority,
} from "../libs/prioritizedBoundedTaskRunner";
import type { CommandExecutorRuntime } from "../types/commandExecutor";
import type { UpdateTopic } from "../types/lifecycle";

/** 按给定的并发与等待上限建一代接纳中的运行状态。 */
export function createCommandExecutorRuntime(
  options: PrioritizedBoundedTaskRunnerOptions
): CommandExecutorRuntime {
  return {
    runner: createPrioritizedBoundedTaskRunner(options),
    controller: new AbortController(),
    tasks: new Set(),
    accepting: true,
  };
}

/** submitCommandExecutorTask 的入参。 */
export interface SubmitCommandExecutorTaskOptions {
  readonly runtime: CommandExecutorRuntime;
  readonly priority: TaskPriority;
  readonly task: () => Promise<unknown>;
  /** 任务意外抛错时写进错误日志的英文前缀。 */
  readonly errorLabel: string;
  /** 只撤销尚未开始的任务的额外取消信号（如 `/wed` 的群取消）；在途任务不受它影响。 */
  readonly queueSignal?: AbortSignal;
  /** 已接纳的任务没有开跑就被撤销（停机、update 取消或 queueSignal）时调用一次；开跑过的任务不调用。 */
  readonly onSkipped?: () => void;
}

/**
 * 同步提交一个任务：合入运行时停止信号与接纳时的 update 取消上下文，任务在自己的取消上下文与
 * 触发话题里运行，不继承释放槽位的另一条任务的上下文；停机取消后的异常不再上报。接纳时
 * update 已取消则返回 false。接纳后没有开跑就被撤销的任务在结算时调用 onSkipped。
 * @see ../../docs/cn/04-invariants.md
 */
export function submitCommandExecutorTask({
  runtime,
  priority,
  task,
  errorLabel,
  queueSignal,
  onSkipped,
}: SubmitCommandExecutorTaskOptions): boolean {
  const taskSignal: AbortSignal = combineWithUpdateAbortSignal(runtime.controller.signal)!;
  if (taskSignal.aborted) return false;
  const queuedSignal: AbortSignal = queueSignal === undefined ? taskSignal : AbortSignal.any([taskSignal, queueSignal]);
  const topic: UpdateTopic | undefined = currentUpdateTopic();
  let started: boolean = false;
  const completion: Promise<unknown> = runtime.runner.run(priority, (): Promise<unknown> => {
    started = true;
    return runWithUpdateAbortSignal(taskSignal, task, topic);
  }, queuedSignal)
    .catch((error: unknown): void => {
      if (!taskSignal.aborted) throw error;
    });
  trackBackgroundTask(runtime.tasks, completion, errorLabel);
  if (onSkipped !== undefined) {
    // 只有开跑过的任务才可能拒绝，拒绝由 trackBackgroundTask 上报；这条派生链只看是否开跑。
    void completion.then((): void => {
      if (!started) onSkipped();
    }, (): void => undefined);
  }
  return true;
}
