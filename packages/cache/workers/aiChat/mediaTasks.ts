import {
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING,
} from "../../../consts/aiChat/media";
import { createPrioritizedBoundedTaskRunner } from "../../../libs/prioritizedBoundedTaskRunner";
import type { PrioritizedBoundedTaskRunner, TaskPriority } from "../../../libs/prioritizedBoundedTaskRunner";

/**
 * Owner：AI 闲聊 Worker。媒体下载/转码/视觉解析共用执行器的内存状态；调用方为
 * aiChat/ai/imageDescription.ts 与 aiChat/ai/tools/replyToolset/imageGeneration.ts。
 */

/**
 * 媒体下载、转码与视觉解析共用的全局有界执行器。模块加载时创建，进程退出
 * 时随 isolate 释放；重启后以空队列重建，容量由媒体并发与等待常量限制。
 *
 * 聊天识别、贴纸目录与生图参考文件共用执行器，均以 interactive 提交；供应商的
 * 交互/后台优先级由调用方另行指定。冷探测等待与本执行器的排队合计不得超过等待上限。
 */
const executor: PrioritizedBoundedTaskRunner = createPrioritizedBoundedTaskRunner({
  maxConcurrent: MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  maxPending: MEDIA_DESCRIPTION_MAX_PENDING,
  maxBackgroundPending: MEDIA_DESCRIPTION_MAX_PENDING,
  interactiveBurst: 1,
});

/** 冷探测等待计数；接纳时递增，取消或结算转执行前递减，Worker 重建归零。容量与执行器排队合计有界。 */
const probeWaits: { current: number } = { current: 0 };

/**
 * 媒体执行入口；模块加载时建立，Worker 重建时连同队列清空。所有入口共享冷探测
 * 等待计数，满额时拒绝新排队任务；空闲执行槽仍可立即接纳任务。
 */
export const mediaTaskRunner: PrioritizedBoundedTaskRunner = {
  get activeCount(): number { return executor.activeCount; },
  get pendingCount(): number { return executor.pendingCount; },
  get backgroundPendingCount(): number { return executor.backgroundPendingCount; },
  run<T>(priority: TaskPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (!hasMediaTaskCapacity(false)) return Promise.resolve(undefined);
    return executor.run(priority, task, signal);
  },
};

/** 同步检查当前媒体准入容量；waitOnly 表示只能等待现有探测，不能使用空闲执行槽。 */
export function hasMediaTaskCapacity(waitOnly: boolean): boolean {
  return (!waitOnly && executor.activeCount < MEDIA_DESCRIPTION_MAX_CONCURRENCY) ||
    executor.pendingCount + probeWaits.current < MEDIA_DESCRIPTION_MAX_PENDING;
}

/** 为冷探测等待保留一个共享等待位；取消或探测结算时调用释放函数，释放后可在同步段内转入执行器。 */
export function reserveMediaProbeWait(): (() => void) | undefined {
  if (!hasMediaTaskCapacity(true)) return undefined;
  probeWaits.current += 1;
  let held: boolean = true;
  return (): void => {
    if (!held) return;
    held = false;
    probeWaits.current -= 1;
  };
}
