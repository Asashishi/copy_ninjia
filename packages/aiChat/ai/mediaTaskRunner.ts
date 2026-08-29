import { mediaTaskRunner } from "../../cache/workers/aiChat/mediaTasks";

/**
 * 把一件媒体任务提交给全局有界执行器。
 *
 * 一律用 `"interactive"`：媒体任务没有可让路的后台档，理由见
 * packages/cache/workers/aiChat/mediaTasks.ts 的说明。
 *
 * @returns 任务结果；并发与等待都已满、或 signal 已取消时是 undefined，
 *   调用方自行降级。
 */
export function runMediaTask<T>(
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T | undefined> {
  return mediaTaskRunner.run("interactive", task, signal);
}
