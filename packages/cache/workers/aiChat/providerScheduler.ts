/**
 * AI 模型请求闸门与能力门面缓存。
 *
 * owner：AI Chat Worker。能力配置注入后按协议、端点、凭据建立最多五条配额 lane；
 * 每条 lane 的活动与等待容量均由 consts/aiChat/provider.ts 限制。Worker 崩溃时
 * isolate 整体销毁，队列与门面自然重建；没有跨线程镜像，也不持久化模型请求。
 */

import type { AiProviderFacadeCache, AiProviderQuotaLane } from "../../../types/aiChat/providerScheduler";

/** 同一 Worker 内已建立的 AI 配额 lane；配置项最多五个，线性匹配只发生在门面首次构造。 */
export const aiProviderQuotaLanes: AiProviderQuotaLane[] = [];

/** 五项能力的稳定门面；首次读取时填充，Worker 重建时恢复为空。 */
export const aiProviderFacades: AiProviderFacadeCache = {
  text: undefined,
  summary: undefined,
  media: undefined,
  mediaBackground: undefined,
  image: undefined,
  song: undefined,
};

/**
 * Worker dispose 与测试隔离时丢弃配额 lane 和稳定门面。生产进程随后销毁整个
 * isolate，不会在旧执行器仍有任务时重建新 lane；测试调用方同样须先结算任务。
 */
export function resetAiProviderSchedulerCache(): void {
  aiProviderQuotaLanes.length = 0;
  aiProviderFacades.text = undefined;
  aiProviderFacades.summary = undefined;
  aiProviderFacades.media = undefined;
  aiProviderFacades.mediaBackground = undefined;
  aiProviderFacades.image = undefined;
  aiProviderFacades.song = undefined;
}
