import { IMAGE_GENERATION_COOLDOWN_MS } from "../../../consts/aiChat/imageGeneration";
import {
  claimCooldown,
  cooldownAvailability,
  releaseCooldownClaim,
  sweepCooldownClaims,
} from "../../../libs/cooldownClaim";
import type { CooldownClaimStore } from "../../../libs/cooldownClaim";
import type { ImageGenerationAvailability, ImageGenerationClaim } from "../../../types/aiChat/imageGeneration";

/**
 * AI 生图工具冷却占位（packages/aiChat/ai/tools/replyToolset/imageGeneration.ts）的
 * 内存状态；aiChatWorker.ts 只驱动周期性 sweepImageGenerationCache 维护。
 * owner: AI 闲聊 Worker 线程（packages/workers/aiChatWorker.ts）。
 *
 * 判定本身在 libs/cooldownClaim.ts —— 那是一个不持有任何缓存的叶子模块，两个
 * 工具共用同一套「先占位、失败按 token 撤销」语义；**表仍然逐份独立**，共用一张
 * 会造出「刚生过图所以十五分钟内不能生歌」这种谁都解释不清的耦合。
 */

/**
 * 每群最近一次普通用户生图占位时间；独立于 AI 回复触发限频且不落盘。
 *
 * 填充：生图工具在发起模型请求前同步 claim。
 * 清理：请求未真正发出时由原占位者 release；到期条目由 Worker 的周期
 * sweepImageGenerationCache 删除。
 * 容量：按群数增长，无硬顶——每条只有一个数字，且 sweep 每个维护周期都会把过期
 * 的删干净（表大小恒等于「最近一个冷却窗口内生过图的群数」）。
 * Worker 崩溃重建：整表清空，等价于所有群的冷却提前结束。这是刻意的 fail-open：
 * 崩溃本来就罕见，而把冷却做成持久化状态要为一个纯限流器引入落盘与对账。
 * 不落盘、不跨线程。
 */
export const imageGenerationClaimTimes: Map<number, number> = new Map();

/** 与 imageGenerationClaimTimes 逐键对齐的占位 token；生命周期完全相同。 */
const imageGenerationClaimTokens: Map<number, symbol> = new Map();

const imageGenerationStore: CooldownClaimStore = {
  claimedAt: imageGenerationClaimTimes,
  tokens: imageGenerationClaimTokens,
  cooldownMs: IMAGE_GENERATION_COOLDOWN_MS,
  tokenLabel: "image-generation-claim",
};

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
  return cooldownAvailability({ store: imageGenerationStore, chatId, bypassCooldown, now });
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
  return claimCooldown({ store: imageGenerationStore, chatId, bypassCooldown, now });
}

/** 只允许原占位者撤销；旧异步请求不能误删同群后来建立的新冷却。 */
export function releaseImageGenerationClaim(chatId: number, token: symbol | null): boolean {
  return releaseCooldownClaim(imageGenerationStore, chatId, token);
}

/** 删除已过期或因时钟回拨落到未来的生图冷却；由 Worker 统一周期维护。 */
export function sweepImageGenerationCache(now: number = Date.now()): void {
  sweepCooldownClaims(imageGenerationStore, now);
}

/** Worker dispose 或测试隔离时清空全部生图占位和冷却。 */
export function resetImageGenerationCache(): void {
  imageGenerationClaimTimes.clear();
  imageGenerationClaimTokens.clear();
}
