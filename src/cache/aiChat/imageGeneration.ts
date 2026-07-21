import { IMAGE_GENERATION_COOLDOWN_MS } from "../../consts/aiChat/imageGeneration";

/** 每群最近一次普通用户生图占位时间；独立于 AI 回复触发限频且不落盘。 */
export const imageGenerationClaimTimes: Map<number, number> = new Map();
const imageGenerationClaimTokens: Map<number, symbol> = new Map();

export type ImageGenerationAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type ImageGenerationClaim =
  | { allowed: true; token: symbol | null }
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
}): ImageGenerationAvailability {
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

export function sweepImageGenerationCache(now: number = Date.now()): void {
  for (const [chatId, claimedAt] of imageGenerationClaimTimes) {
    if (claimedAt > now || now - claimedAt >= IMAGE_GENERATION_COOLDOWN_MS) {
      imageGenerationClaimTimes.delete(chatId);
      imageGenerationClaimTokens.delete(chatId);
    }
  }
}

export function resetImageGenerationCache(): void {
  imageGenerationClaimTimes.clear();
  imageGenerationClaimTokens.clear();
}
