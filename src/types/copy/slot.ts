import type { CachedUser, CopyMode } from "../chatState";

/** 跨群 /copy 启动流程的同步占位；不同群不会被 grammY 的按群串行器互斥。 */
export interface CopySlotClaim {
  readonly token: symbol;
  readonly copyChatId: number;
}

/** 目标解析完成后原子提交到全局 copy 状态的字段。 */
export interface CopySlotTarget {
  copiedUser: CachedUser;
  copyMode: CopyMode | undefined;
  copyChatId: number;
}

/** 尝试占用全局 copy 槽的同步结果。 */
export type CopySlotDecision =
  | { claimed: true; claim: CopySlotClaim }
  | { claimed: false; reason: "active"; copiedUser: CachedUser }
  | { claimed: false; reason: "pending" };
