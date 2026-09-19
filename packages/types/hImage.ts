import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

/** `/h_image` 的主线程执行器状态（cache/main/hImage.ts）。 */
export interface HImageRuntime {
  readonly runner: PrioritizedBoundedTaskRunner;
  /** 停机超时时取消排队与在途请求。 */
  readonly controller: AbortController;
  /** 已接纳、尚未结算的请求；结算自摘除。 */
  readonly tasks: Set<Promise<void>>;
  accepting: boolean;
}
