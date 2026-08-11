/**
 * 「先占位、再发请求、失败按 token 撤销」的按群冷却骨架。
 *
 * 生图与生歌两个工具的冷却语义逐字相同，只有冷却时长和各自的表不同。本模块**不
 * 持有任何缓存**：两张 Map 仍由各自的 owner 文件声明并按 AGENTS.md 写清填充、
 * 清理、容量与 Worker 重建策略（见 cache/workers/aiChat/{image,song}Generation.ts），
 * 这里只接收它们并实现共享判定，符合「纯函数不得与另一线程独占缓存放在同一文件」。
 *
 * token 是这套语义里唯一不显然的部分：撤销必须校验 token，否则一次迟到的失败
 * 回调会删掉同群后来建立的**新**冷却，让下一次请求立刻穿透。
 */

/** 某群当前资格及不可用时的剩余冷却。 */
export type CooldownAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 原子占位结果；token 只供原占位者释放，旁路占位不产生 token。 */
export type CooldownClaim =
  | { allowed: true; token: symbol | null }
  | { allowed: false; retryAfterMs: number };

/** 一份按群冷却的全部状态；由 owner 文件提供，本模块只读写不持有。 */
export interface CooldownClaimStore {
  /** 每群最近一次占位时刻。 */
  readonly claimedAt: Map<number, number>;
  /** 与 claimedAt 逐键对齐的占位 token。 */
  readonly tokens: Map<number, symbol>;
  /** 冷却时长。 */
  readonly cooldownMs: number;
  /** Symbol 描述，只用于调试可读性。 */
  readonly tokenLabel: string;
}

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
