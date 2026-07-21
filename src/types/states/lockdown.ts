import type { ChatPermissions } from "@grammyjs/types";

export type LockdownState =
  | { kind: "applying"; originalPermissions?: ChatPermissions; joinCount?: number; intentId?: number }
  | { kind: "active"; originalPermissions: ChatPermissions; intentId: number }
  | { kind: "restoring"; originalPermissions: ChatPermissions; intentId: number };

export type LockdownMachineEvent =
  | { type: "thresholdExceeded"; joinCount: number }
  | { type: "applyPrepared"; originalPermissions: ChatPermissions; joinCount: number; intentId: number }
  | { type: "applyPreparationFailed" }
  | { type: "statePersisted"; phase: "applying" | "active" | "restoring"; intentId: number }
  | { type: "applyResult"; ok: true }
  | { type: "applyResult"; ok: false; restoreIntentId: number }
  | { type: "restoreTimerFired"; intentId: number }
  | { type: "restoreRetryFired" }
  | { type: "deactivate"; intentId: number }
  | { type: "restoreResult"; ok: boolean }
  | {
    type: "adopt";
    phase: "applying" | "active" | "restoring";
    originalPermissions: ChatPermissions;
    intentId: number;
    remainingMs: number;
    persisted?: boolean;
  };

export type LockdownEffect =
  /** 预热管理员表：锁定期内「管理员拉人免验证」只认同步缓存判定。 */
  | { kind: "prefetchAdmins"; onlyIfCold: boolean }
  /** 只读取原权限；此阶段绝不修改 Telegram。 */
  | { kind: "prepareApply"; joinCount: number }
  /** 把当前 applying/active/restoring 状态交给主线程落盘。 */
  | { kind: "persistState" }
  /** applying intent 已落盘，可以收紧 invite 权限。 */
  | { kind: "commitApply"; originalPermissions: ChatPermissions }
  /** （重新）安排恢复计时器，到期投递 restoreTimerFired。 */
  | { kind: "scheduleRestore"; delayMs: number }
  | { kind: "scheduleRestoreRetry"; delayMs: number }
  /** 异步恢复原始权限，结果以 restoreResult 回投。 */
  | { kind: "beginRestore"; originalPermissions: ChatPermissions }
  /** 重新读取当前权限并只补回 invite 限制（见 restoreResult 里
   *  "迟到的旧恢复成功、但当前仍应保持 ACTIVE"分支）。 */
  | { kind: "reapplyRestriction"; originalPermissions: ChatPermissions }
  | { kind: "reportUnlock" }
  /** joinCount 仅在本 Worker 亲历触发时可知；接管 applying intent 时缺失。 */
  | { kind: "announceLockdown"; joinCount?: number }
  | { kind: "announceUnlock" };

export interface LockdownTransition {
  /** 下一个状态：undefined = 删除记录；与传入同一对象 = 保持（计时器由 scheduleRestore 副作用管理）。 */
  next: LockdownState | undefined;
  effects: LockdownEffect[];
}
