import type { ChatPermissions } from "@grammyjs/types";
import type { LockdownPhase } from "../chatState";

/** 尚在读取原权限、没有形成可持久化 intent 的同步占位。 */
export interface LockdownPreparingState {
  kind: "applying";
  stage: "preparing";
}

/** 已取得原权限并形成完整 intent，等待落盘回执或 Telegram 写入结果。 */
export interface LockdownPreparedState {
  kind: "applying";
  stage: "prepared";
  originalPermissions: ChatPermissions;
  /** Worker 重建接管时无法恢复触发瞬间的入群人数。 */
  joinCount?: number;
  intentId: number;
}

/**
 * announced：本次锁定有没有真的在群里公告过。
 *
 * 公告只在 applyResult(ok) 那一步发出（APPLYING → ACTIVE），而 RESTORING 有
 * 两个入口：正常到期/手动解除（来自 ACTIVE，公告过）与加锁调用失败后的补偿
 * 对账（applyResult(!ok)，从未公告过）。少了这面旗，后一条路恢复成功时会往
 * 群里发一条「限制解除」——而那个群从头到尾没收到过封锁公告，读起来是句没头
 * 没尾的话。该字段必须随状态持久化；否则崩溃后无法区分正常到期恢复和加锁
 * 结果不确定后的补偿恢复，会凭空发送一条没有前文的解锁公告。
 */
export type LockdownState =
  | LockdownPreparingState
  | LockdownPreparedState
  | {
    kind: "active";
    originalPermissions: ChatPermissions;
    intentId: number;
    announced: boolean;
    /** 加锁成功后的 active(false) 已落盘，收到回执后才能开始发送公告。 */
    announcementPending: boolean;
    /** Worker 亲历触发时的入群数；接管 applying intent 时为 undefined。 */
    announcementJoinCount: number | undefined;
  }
  | {
    /** 迟到恢复已打开邀请权限，当前正在把 ACTIVE 意图重新对账到 Telegram。 */
    kind: "reconciling";
    originalPermissions: ChatPermissions;
    intentId: number;
    announced: boolean;
    /** true 时只等本阶段落盘回执，回执到达后恰好启动一次纠偏。 */
    reapplyAfterPersist: boolean;
  }
  | {
    kind: "restoring";
    originalPermissions: ChatPermissions;
    intentId: number;
    announced: boolean;
    /** true 时只等本阶段落盘回执，回执到达后恰好启动一次恢复。 */
    restoreAfterPersist: boolean;
  };

export type LockdownMachineEvent =
  | { type: "thresholdExceeded"; joinCount: number }
  | { type: "applyPrepared"; originalPermissions: ChatPermissions; joinCount: number; intentId: number }
  | { type: "applyPreparationFailed" }
  | { type: "applyCommitPreparationFailed" }
  | { type: "statePersisted"; phase: LockdownPhase; intentId: number }
  | { type: "applyResult"; ok: true }
  | { type: "applyResult"; ok: false; restoreIntentId: number }
  | { type: "restoreTimerFired"; intentId: number }
  | { type: "restoreRetryFired" }
  | { type: "reapplyRetryFired" }
  | { type: "deactivate"; intentId: number }
  | { type: "restoreResult"; ok: boolean }
  | { type: "reapplyResult"; ok: boolean }
  | { type: "announcementResult"; ok: boolean }
  | {
    type: "adopt";
    phase: LockdownPhase;
    originalPermissions: ChatPermissions;
    intentId: number;
    announced: boolean;
    remainingMs: number;
    persisted?: boolean;
  };

export type LockdownEffect =
  /** 预热管理员表：锁定期内「管理员拉人免验证」只认同步缓存判定。 */
  | { kind: "prefetchAdmins"; onlyIfCold: boolean }
  /** 只读取原权限；此阶段绝不修改 Telegram。 */
  | { kind: "prepareApply"; joinCount: number }
  /** 把当前非 idle 状态交给主线程落盘。 */
  | { kind: "persistState" }
  /** applying intent 已落盘，可以重新读取最新权限并收紧 invite 权限。 */
  | { kind: "commitApply" }
  /** （重新）安排恢复计时器，到期投递 restoreTimerFired。 */
  | { kind: "scheduleRestore"; delayMs: number }
  | { kind: "scheduleRestoreRetry"; delayMs: number }
  /** 异步恢复原始权限，结果以 restoreResult 回投。 */
  | { kind: "beginRestore"; originalPermissions: ChatPermissions }
  /** 持久化 RECONCILING 后重新收紧 invite 权限，结果必须回投状态机。 */
  | { kind: "beginReapply" }
  /** 纠偏失败后的有界退避重试。 */
  | { kind: "scheduleReapplyRetry"; delayMs: number }
  | { kind: "reportUnlock" }
  /** active(false) 落盘后发送公告；结果必须回投，不能把发送尝试当成发送成功。 */
  | { kind: "beginLockdownAnnouncement"; joinCount?: number }
  | { kind: "announceUnlock" };

export interface LockdownTransition {
  /** 下一个状态：undefined = 删除记录；与传入同一对象 = 保持（计时器由 scheduleRestore 副作用管理）。 */
  next: LockdownState | undefined;
  effects: LockdownEffect[];
}
