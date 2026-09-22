import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

/** 延迟命令执行器的主线程状态（cache/main/deferredCommands.ts）。 */
export interface DeferredCommandRuntime {
  readonly runner: PrioritizedBoundedTaskRunner;
  /** 停机超时时取消排队与在途任务。 */
  readonly controller: AbortController;
  /** 已接纳、尚未结算的任务；结算自摘除。 */
  readonly tasks: Set<Promise<void>>;
  accepting: boolean;
}
