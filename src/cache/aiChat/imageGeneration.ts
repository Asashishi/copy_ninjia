import { IMAGE_GENERATION_COOLDOWN_MS } from "../../consts/aiChat/imageGeneration";

/** 每群最近一次普通用户生图占位时间；独立于 AI 回复触发限频且不落盘。 */
export const imageGenerationClaimTimes: Map<number, number> = new Map();

export type ImageGenerationClaim =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 只读取某群此刻的生图可用性；工具 schema 用它在调用前告知模型当前状态。 */
export function getImageGenerationAvailability({
  chatId,
  bypassCooldown,
  now = Date.now(),
}: {
  chatId: number;
  bypassCooldown: boolean;
  now?: number;
}): ImageGenerationClaim {
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
}: {
  chatId: number;
  bypassCooldown: boolean;
  now?: number;
}): ImageGenerationClaim {
  const availability: ImageGenerationClaim = getImageGenerationAvailability({ chatId, bypassCooldown, now });
  if (!availability.allowed) return availability;
  if (bypassCooldown) return availability;
  imageGenerationClaimTimes.set(chatId, now);
  return { allowed: true };
}

export function sweepImageGenerationCache(now: number = Date.now()): void {
  for (const [chatId, claimedAt] of imageGenerationClaimTimes) {
    if (claimedAt > now || now - claimedAt >= IMAGE_GENERATION_COOLDOWN_MS) {
      imageGenerationClaimTimes.delete(chatId);
    }
  }
}

export function resetImageGenerationCache(): void {
  imageGenerationClaimTimes.clear();
}
