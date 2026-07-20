import type { CachedUser, CopyMode, GlobalCopyState } from "../types/chatState";

/** 跨群 /copy 启动流程的同步占位；不同群不会被 grammY 的按群串行器互斥。 */
export interface CopySlotClaim {
  readonly token: symbol;
  readonly copyChatId: number;
}

export type CopySlotDecision =
  | { claimed: true; claim: CopySlotClaim }
  | { claimed: false; reason: "active"; copiedUser: CachedUser }
  | { claimed: false; reason: "pending" };

let pendingCopySlotClaim: CopySlotClaim | null = null;

/**
 * 在同一个同步执行栈里检查并占住全局 copy 槽。占位必须早于目标解析、冷却
 * 检查等 await；否则两个群可同时读到 copiedUser=null 并先后覆盖状态。
 */
export function claimCopySlot(globalCopy: GlobalCopyState, copyChatId: number): CopySlotDecision {
  if (globalCopy.copiedUser !== null) {
    return { claimed: false, reason: "active", copiedUser: globalCopy.copiedUser };
  }
  if (pendingCopySlotClaim !== null) return { claimed: false, reason: "pending" };
  const claim: CopySlotClaim = { token: Symbol("copy-slot"), copyChatId };
  pendingCopySlotClaim = claim;
  return { claimed: true, claim };
}

/** 仅当前占位持有者可以把已解析目标原子提交为活动 copy。 */
export function commitCopySlot(
  claim: CopySlotClaim,
  globalCopy: GlobalCopyState,
  target: { copiedUser: CachedUser; copyMode: CopyMode | undefined; copyChatId: number }
): boolean {
  if (pendingCopySlotClaim?.token !== claim.token || globalCopy.copiedUser !== null) return false;
  globalCopy.copiedUser = target.copiedUser;
  globalCopy.copyMode = target.copyMode;
  globalCopy.copyChatId = target.copyChatId;
  pendingCopySlotClaim = null;
  return true;
}

/** 目标解析、冷却检查或后续校验失败时释放尚未提交的占位。 */
export function releaseCopySlot(claim: CopySlotClaim): void {
  if (pendingCopySlotClaim?.token === claim.token) pendingCopySlotClaim = null;
}

/** /stop_copy 可取消还在解析目标/检查冷却的启动流程。 */
export function cancelPendingCopySlot(): boolean {
  if (pendingCopySlotClaim === null) return false;
  pendingCopySlotClaim = null;
  return true;
}

/** 群 teardown 只取消由该群发起、尚未提交的 copy。 */
export function cancelPendingCopySlotOwnedBy(copyChatId: number): boolean {
  if (pendingCopySlotClaim?.copyChatId !== copyChatId) return false;
  pendingCopySlotClaim = null;
  return true;
}
