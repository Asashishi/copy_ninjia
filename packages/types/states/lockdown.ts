import type { ChatPermissions } from "grammy/types";
import type { LockdownPhase } from "../chatState";

/**
 * 每个阶段都携带的封锁公告记账。
 *
 * announced：本次锁定有没有真的在群里公告过。公告在进入 APPLYING 占位的同一刻发出；
 * 它同时决定解除时发不发解锁公告：加锁调用失败后的补偿对账（applyResult(!ok)）在公告
 * 没发出去时，恢复成功不发「限制解除」。该字段随状态持久化。
 *
 * announcementPending：这一轮有一次公告在途或待发（结果以 announcementResult
 * 回投）。只活在内存里；跨进程接管时，落盘为「公告过」即照单接受，为「没公告过」而
 * 锁定仍要继续时补发一次并重新置位。
 *
 * announcementMessageId：公告消息 ID，与 announced 同时成立（落盘恢复由 database/codec/chatState.ts
 * 校验）；解除封锁时按它删除，随状态持久化。没公告过时为 undefined，此时不删。
 */
export interface LockdownAnnouncement {
  announced: boolean;
  announcementPending: boolean;
  announcementMessageId: number | undefined;
}

/** 尚在读取原权限、没有形成可持久化 intent 的同步占位。 */
export interface LockdownPreparingState extends LockdownAnnouncement {
  kind: "applying";
  stage: "preparing";
}

/** 已取得原权限并形成完整 intent，等待落盘回执或 Telegram 写入结果。 */
export interface LockdownPreparedState extends LockdownAnnouncement {
  kind: "applying";
  stage: "prepared";
  originalPermissions: ChatPermissions;
  intentId: number;
  /**
   * 本轮已派发 commitApply，重复落盘回执不得再次派发。
   * 任务可能仍在串行链或权限查询中；该标志不代表 Telegram 已提交。
   * 持久化失败按可能在途处理，保留恢复责任；取消后的任务在写入前复核身份。
   * 只活在内存里；接管一份已确认落盘的 intent 时随 commitApply 一起置位。
   */
  commitStarted: boolean;
}

export type LockdownState =
  | LockdownPreparingState
  | LockdownPreparedState
  | ({
    kind: "active";
    originalPermissions: ChatPermissions;
    intentId: number;
  } & LockdownAnnouncement)
  | ({
    /** 迟到恢复已打开邀请权限，当前正在把 ACTIVE 意图重新对账到 Telegram。 */
    kind: "reconciling";
    originalPermissions: ChatPermissions;
    intentId: number;
    /** true 时只等本阶段落盘回执，回执到达后恰好启动一次纠偏。 */
    reapplyAfterPersist: boolean;
  } & LockdownAnnouncement)
  | ({
    kind: "restoring";
    originalPermissions: ChatPermissions;
    intentId: number;
    /** true 时只等本阶段落盘回执，回执到达后恰好启动一次恢复。 */
    restoreAfterPersist: boolean;
    /** 恢复成功时解锁公告用哪句文案；只活在内存里，见 LockdownRestoreReason。 */
    restoreReason: LockdownRestoreReason;
  } & LockdownAnnouncement);

/**
 * 进入 RESTORING 的原因：`expired` 为本轮到期，`lifted` 为到期前恢复（主动解除、加锁结果不确定后的补偿、
 * 落盘失败）。不随状态持久化；接管落盘的 RESTORING 时原因未知，按 `lifted` 处理。
 */
export type LockdownRestoreReason = "expired" | "lifted";

export type LockdownMachineEvent =
  | { type: "thresholdExceeded"; joinCount: number }
  | { type: "applyPrepared"; originalPermissions: ChatPermissions; intentId: number }
  | { type: "applyPreparationFailed" }
  | { type: "applyCommitPreparationFailed" }
  | { type: "statePersisted"; phase: LockdownPhase; intentId: number }
  /**
   * 这一轮意图确定写不进 SQLite：占位直接撤销，已经落地的限制立刻恢复（见状态机
   * persistFailed 分支）。
   */
  | { type: "persistFailed"; phase: LockdownPhase; intentId: number }
  | { type: "applyResult"; ok: true }
  | { type: "applyResult"; ok: false; restoreIntentId: number }
  | { type: "restoreTimerFired"; intentId: number }
  | { type: "restoreRetryFired" }
  | { type: "reapplyRetryFired" }
  | { type: "deactivate"; intentId: number }
  | { type: "restoreResult"; ok: boolean }
  | { type: "reapplyResult"; ok: boolean }
  /** 公告发送结果：发送成功时为消息 ID，供解除时定向删除；发送失败为 undefined。 */
  | { type: "announcementResult"; messageId: number | undefined }
  | {
    type: "adopt";
    phase: LockdownPhase;
    originalPermissions: ChatPermissions;
    intentId: number;
    announced: boolean;
    announcementMessageId?: number;
    remainingMs: number;
    /** 同 AdoptableLockdown.persisted。 */
    persisted: boolean;
  };

/**
 * 一轮私密模式被判定作废的原因，决定日志文案。suppressRetrigger 冷却由状态机在真正
 * 作废的那条转移里发出，迟到或重复的失败通知撞上已换代的状态时不产生冷却。
 */
export type LockdownAbandonReason =
  | "preparationFailed"
  | "commitPreparationFailed"
  | "persistFailed";

export type LockdownEffect =
  /** 预热管理员表：锁定期内「管理员拉人免验证」只认同步缓存判定。 */
  | { kind: "prefetchAdmins"; onlyIfCold: boolean }
  /** 只读取原权限；此阶段不修改 Telegram。 */
  | { kind: "prepareApply" }
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
  /** 占位落地后发封锁公告；结果回投状态机。 */
  | { kind: "beginLockdownAnnouncement"; joinCount?: number }
  /** 本轮结束，删除群里那条封锁公告；只在确知 messageId 时发出。 */
  | { kind: "deleteLockdownAnnouncement"; messageId: number }
  /** 本轮作废：在冷却期内不再让入群把这个群重新推进私密模式。 */
  | { kind: "suppressRetrigger"; reason: LockdownAbandonReason; durationMs: number }
  /** 恢复成功且本轮公告过：按 reason 发到期或提前解除的解锁公告。 */
  | { kind: "announceUnlock"; reason: LockdownRestoreReason };

export interface LockdownTransition {
  /** 下一个状态：undefined = 删除记录；与传入同一对象 = 保持（计时器由 scheduleRestore 副作用管理）。 */
  next: LockdownState | undefined;
  /** 只读：无副作用时是共享的 NO_LOCKDOWN_EFFECTS（consts/antiRaid/lockdown.ts）。 */
  effects: readonly LockdownEffect[];
}
