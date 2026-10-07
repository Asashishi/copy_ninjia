/**
 * 「先占位、再发请求、失败按 token 撤销」的按群冷却骨架。
 *
 * 本模块不持有任何缓存：冷却表由 owner 文件声明并按 AGENTS.md 写清填充、
 * 清理、容量与 Worker 重建策略（见 cache/workers/aiChat/imageGeneration.ts），
 * 这里只接收它并实现判定。
 *
 * 撤销按 token 校验：只有原占位者的 token 能删除冷却，迟到的失败回调不影响同群后来
 * 建立的新冷却。
 */

import type { CooldownAvailability, CooldownClaim, CooldownClaimStore } from "../types/cooldown";

export interface CooldownClaimParams {
  readonly store: CooldownClaimStore;
  readonly chatId: number;
  /** 旁路身份既不读取也不更新普通用户冷却。 */
  readonly bypassCooldown: boolean;
  readonly now: number;
}

/** 只读检查当前冷却，不建立占位。 */
export function cooldownAvailability({
  store,
  chatId,
  bypassCooldown,
  now,
}: CooldownClaimParams): CooldownAvailability {
  if (bypassCooldown) return { allowed: true };
  const previous: number | undefined = store.claimedAt.get(chatId);
  if (previous === undefined) return { allowed: true };
  const elapsed: number = now - previous;
  return elapsed >= 0 && elapsed < store.cooldownMs
    ? { allowed: false, retryAfterMs: store.cooldownMs - elapsed }
    : { allowed: true };
}

/** 在发起请求前同步占位，保证同群并发轮次不能同时穿透。 */
export function claimCooldown(params: CooldownClaimParams): CooldownClaim {
  const availability: CooldownAvailability = cooldownAvailability(params);
  if (!availability.allowed) return availability;
  if (params.bypassCooldown) return { allowed: true, token: null };
  const token: symbol = Symbol(params.store.tokenLabel);
  params.store.claimedAt.set(params.chatId, params.now);
  params.store.tokens.set(params.chatId, token);
  return { allowed: true, token };
}

/** 只允许原占位者撤销；旧异步请求不能误删同群后来建立的新冷却。 */
export function releaseCooldownClaim(
  store: CooldownClaimStore,
  chatId: number,
  token: symbol | null
): boolean {
  if (token === null || store.tokens.get(chatId) !== token) return false;
  store.tokens.delete(chatId);
  store.claimedAt.delete(chatId);
  return true;
}

/** 删除已过期或因时钟回拨落到未来的冷却。 */
export function sweepCooldownClaims(store: CooldownClaimStore, now: number): void {
  for (const [chatId, claimedAt] of store.claimedAt) {
    if (claimedAt > now || now - claimedAt >= store.cooldownMs) {
      store.claimedAt.delete(chatId);
      store.tokens.delete(chatId);
    }
  }
}
