import { IMAGE_GENERATION_COOLDOWN_MS } from "../../consts/aiChat/imageGeneration";
import type { ImageGenerationAvailability, ImageGenerationClaim } from "../../types/aiChat/imageGeneration";

/**
 * AI 生图工具冷却占位（packages/ai/tools/replyToolset/imageGeneration.ts）的
 * 内存状态；aiChatWorker.ts 只驱动周期性 sweepImageGenerationCache 维护。
 */

/** 每群最近一次普通用户生图占位时间；独立于 AI 回复触发限频且不落盘。 */
export const imageGenerationClaimTimes: Map<number, number> = new Map();
const imageGenerationClaimTokens: Map<number, symbol> = new Map();

/** 只读取某群此刻的生图可用性；工具 schema 用它在调用前告知模型当前状态。 */
export interface ImageGenerationCooldownParams {
  chatId: number;
  bypassCooldown: boolean;
  now?: number;
}

/** 只读检查当前冷却，不建立占位。 */
export function getImageGenerationAvailability({
  chatId,
  bypassCooldown,
  now = Date.now(),
}: ImageGenerationCooldownParams): ImageGenerationAvailability {
  if (bypassCooldown) return { allowed: true };
  const previous: number | undefined = imageGenerationClaimTimes.get(chatId);
  if (previous === undefined) return { allowed: true };
  const elapsed: number = now - previous;
  return elapsed >= 0 && elapsed < IMAGE_GENERATION_COOLDOWN_MS
    ? { allowed: false, retryAfterMs: IMAGE_GENERATION_COOLDOWN_MS - elapsed }
    : { allowed: true };
}

/**
 * 在发起模型请求前同步占位，保证同群并发回复轮不能同时穿透。superAdmin
 * 旁路既不读取也不更新普通用户冷却。
 */
export function claimImageGeneration({
  chatId,
  bypassCooldown,
  now = Date.now(),
}: ImageGenerationCooldownParams): ImageGenerationClaim {
  const availability: ImageGenerationAvailability = getImageGenerationAvailability({ chatId, bypassCooldown, now });
  if (!availability.allowed) return availability;
  if (bypassCooldown) return { allowed: true, token: null };
  const token: symbol = Symbol("image-generation-claim");
  imageGenerationClaimTimes.set(chatId, now);
  imageGenerationClaimTokens.set(chatId, token);
  return { allowed: true, token };
}

/** 只允许原占位者撤销；旧异步请求不能误删同群后来建立的新冷却。 */
export function releaseImageGenerationClaim(chatId: number, token: symbol | null): boolean {
  if (token === null || imageGenerationClaimTokens.get(chatId) !== token) return false;
  imageGenerationClaimTokens.delete(chatId);
  imageGenerationClaimTimes.delete(chatId);
  return true;
}

/** 删除已过期或因时钟回拨落到未来的生图冷却；由 Worker 统一周期维护。 */
export function sweepImageGenerationCache(now: number = Date.now()): void {
  for (const [chatId, claimedAt] of imageGenerationClaimTimes) {
    if (claimedAt > now || now - claimedAt >= IMAGE_GENERATION_COOLDOWN_MS) {
      imageGenerationClaimTimes.delete(chatId);
      imageGenerationClaimTokens.delete(chatId);
    }
  }
}

/** Worker dispose 或测试隔离时清空全部生图占位和冷却。 */
export function resetImageGenerationCache(): void {
  imageGenerationClaimTimes.clear();
  imageGenerationClaimTokens.clear();
}
