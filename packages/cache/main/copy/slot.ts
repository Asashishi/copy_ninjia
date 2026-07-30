import type { CopySlotClaim } from "../../../types/copy/slot";

/** /copy 槽位占用（packages/commands/copySlot.ts）的内存状态。 */

/**
 * /copy 尚在解析目标或校验冷却时的唯一占位。claimCopySlot 填充，提交、
 * 失败、/stop_copy 或发起群 teardown 时清空；进程重启后无需恢复，容量固定为一项。
 */
export const pendingCopySlotClaim: { current: CopySlotClaim | null } = { current: null };
