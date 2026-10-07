/** 某群当前资格及不可用时的剩余冷却。 */
export type CooldownAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 原子占位结果；token 只供原占位者释放，旁路占位不产生 token。 */
export type CooldownClaim =
  | { allowed: true; token: symbol | null }
  | { allowed: false; retryAfterMs: number };

/** 一份按群冷却的全部状态；由 owner 文件提供，libs/cooldownClaim.ts 只读写不持有。 */
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
