import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

/**
 * 主线程命令执行器的一代运行状态（`/wed` 与延迟命令各一份，见 infra/commandExecutor.ts）；
 * 排队与在途任务都由停机边界观察。
 */
export interface CommandExecutorRuntime {
  readonly runner: PrioritizedBoundedTaskRunner;
  /** 停机超时时取消排队与在途任务。 */
  readonly controller: AbortController;
  /** 已接纳、尚未结算的任务；结算自摘除。 */
  readonly tasks: Set<Promise<void>>;
  accepting: boolean;
}
