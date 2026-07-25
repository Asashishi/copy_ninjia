import { pendingCopySlotClaim } from "../cache/copy/slot";
import type { GlobalCopyState } from "../types/chatState";
import type { CopySlotClaim, CopySlotDecision, CopySlotTarget } from "../types/copy/slot";

export type { CopySlotClaim, CopySlotDecision } from "../types/copy/slot";

/**
 * 在同一个同步执行栈里检查并占住全局 copy 槽。占位必须早于目标解析、冷却
 * 检查等 await；否则两个群可同时读到 copiedUser=null 并先后覆盖状态。
 */
export function claimCopySlot(globalCopy: GlobalCopyState, copyChatId: number): CopySlotDecision {
  if (globalCopy.copiedUser !== null) {
    return { claimed: false, reason: "active", copiedUser: globalCopy.copiedUser };
  }
  if (pendingCopySlotClaim.current !== null) return { claimed: false, reason: "pending" };
  const claim: CopySlotClaim = { token: Symbol("copy-slot"), copyChatId };
  pendingCopySlotClaim.current = claim;
  return { claimed: true, claim };
}

/** 仅当前占位持有者可以把已解析目标原子提交为活动 copy。 */
export function commitCopySlot(
  claim: CopySlotClaim,
  globalCopy: GlobalCopyState,
  target: CopySlotTarget
): boolean {
  if (pendingCopySlotClaim.current?.token !== claim.token || globalCopy.copiedUser !== null) return false;
  globalCopy.copiedUser = target.copiedUser;
  globalCopy.copyMode = target.copyMode;
  globalCopy.copyChatId = target.copyChatId;
  pendingCopySlotClaim.current = null;
  return true;
}

/** 目标解析、冷却检查或后续校验失败时释放尚未提交的占位。 */
export function releaseCopySlot(claim: CopySlotClaim): void {
  if (pendingCopySlotClaim.current?.token === claim.token) pendingCopySlotClaim.current = null;
}

/** /stop_copy 可取消还在解析目标/检查冷却的启动流程。 */
export function cancelPendingCopySlot(): boolean {
  if (pendingCopySlotClaim.current === null) return false;
  pendingCopySlotClaim.current = null;
  return true;
}

/** 群 teardown 只取消由该群发起、尚未提交的 copy。 */
export function cancelPendingCopySlotOwnedBy(copyChatId: number): boolean {
  if (pendingCopySlotClaim.current?.copyChatId !== copyChatId) return false;
  pendingCopySlotClaim.current = null;
  return true;
}
