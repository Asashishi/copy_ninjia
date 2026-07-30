import {
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING,
} from "../../../consts/aiChat/media";
import { createBoundedTaskRunner } from "../../../libs/boundedTaskRunner";

/** 媒体下载/转码/视觉解析执行器（packages/ai/mediaTaskRunner.ts）的内存状态。 */

/**
 * 媒体下载、转码与视觉解析共用的全局有界执行器。模块加载时创建，进程退出
 * 时随 isolate 释放；重启后以空队列重建，容量由媒体并发与等待常量限制。
 */
export const mediaTaskRunner: ReturnType<typeof createBoundedTaskRunner> = createBoundedTaskRunner(
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING
);
