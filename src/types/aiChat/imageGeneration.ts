/** 某群当前生图资格及不可用时的剩余冷却。 */
export type ImageGenerationAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 生图原子占位结果；token 只供原占位者释放。 */
export type ImageGenerationClaim =
  | { allowed: true; token: symbol | null }
  | { allowed: false; retryAfterMs: number };
