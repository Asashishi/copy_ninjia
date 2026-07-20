import {
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING,
} from "../consts/aiChat/media";
import { createBoundedTaskRunner } from "../libs/boundedTaskRunner";

// 下载、sharp 转码与视觉解析共用同一份跨群预算。生图参考素材也必须走这里，
// 不能只依赖按群的生图冷却来约束全局原生线程与 Telegram 下载压力。
const mediaTaskRunner = createBoundedTaskRunner(
  MEDIA_DESCRIPTION_MAX_CONCURRENCY,
  MEDIA_DESCRIPTION_MAX_PENDING
);

export function runMediaTask<T>(task: () => Promise<T>): Promise<T | undefined> {
  return mediaTaskRunner.run(task);
}
