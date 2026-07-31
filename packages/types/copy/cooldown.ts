/** copy 类命令因全局冷却被拒绝。 */
export interface RejectedCopyCooldownClaim {
  rejected: true;
}

/** copy 类命令成功占用全局冷却，包含可安全回滚的比较值。 */
export interface GrantedCopyCooldownClaim {
  rejected: false;
  previousLastCopyTime: number | undefined;
  claimedAt: number;
}

/** copy 类命令的原子冷却占位结果。 */
export type CopyCooldownClaim =
  | RejectedCopyCooldownClaim
  | GrantedCopyCooldownClaim;
