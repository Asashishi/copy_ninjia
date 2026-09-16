import {
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING,
} from "../../../consts/aiChat/media";
import { createPrioritizedBoundedTaskRunner } from "../../../libs/prioritizedBoundedTaskRunner";
import type { PrioritizedBoundedTaskRunner } from "../../../libs/prioritizedBoundedTaskRunner";

/**
 * Owner：AI 闲聊 Worker。媒体下载/转码/视觉解析共用执行器的内存状态；调用方为
 * aiChat/ai/imageDescription.ts 与 aiChat/ai/tools/replyToolset/imageGeneration.ts。
 */

/**
 * 媒体下载、转码与视觉解析共用的全局有界执行器。模块加载时创建，进程退出
 * 时随 isolate 释放；重启后以空队列重建，容量由媒体并发与等待常量限制。
 *
 * 媒体任务只有一档：每一件都直接挂在某条真人可见的回复上，没有「后台对账」那类
 * 可以让路的活。因此 `maxBackgroundPending` 取满 `maxPending`、`interactiveBurst`
 * 取 1，调用方一律以 `"interactive"` 提交；两档退化成一档后，调度与单档执行器
 * 逐条等价（FIFO、饱和即拒、排队中可取消）。
 */
export const mediaTaskRunner: PrioritizedBoundedTaskRunner = createPrioritizedBoundedTaskRunner({
  maxConcurrent: MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  maxPending: MEDIA_DESCRIPTION_MAX_PENDING,
  maxBackgroundPending: MEDIA_DESCRIPTION_MAX_PENDING,
  interactiveBurst: 1,
});
