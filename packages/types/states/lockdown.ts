import type { ChatPermissions } from "grammy/types";
import type { LockdownPhase } from "../chatState";

/**
 * 每个阶段都携带的封锁公告记账。
 *
 * announced：本次锁定有没有真的在群里公告过。公告在**进入 APPLYING 占位的
 * 同一刻**发出——占位一落地，新进群的人就开始被直接请出去，群里必须先看到
 * 「为什么进不来人」。它同时决定解除时发不发解锁公告：加锁调用失败后的补偿
 * 对账（applyResult(!ok)）如果公告没发出去，恢复成功时就不能凭空丢一句
 * 「限制解除」。该字段必须随状态持久化，否则崩溃后无法区分两条恢复路径。
 *
 * announcementPending：这一轮有一次公告在途或待发（结果以 announcementResult
 * 回投）。只活在内存里：跨进程接管时上一代那次发送的结局已无从追认——落盘说
 * 「公告过」就照单接受，说「没公告过」而锁定仍要继续时补发一次并重新置位。
 *
 * announcementMessageId：公告消息 ID，解除封锁时按它删除。必须随状态持久化，
 * 否则进程重启后接管的那一轮解除时删不掉群里那条公告。发送失败、或接管的是
 * 老进程留下的记录时为 undefined——删不掉就不删，绝不猜 ID。
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
  /** Worker 重建接管时无法恢复触发瞬间的入群人数。 */
  joinCount?: number;
  intentId: number;
  /**
   * 本轮 intent 的 commitApply 已经发出过一次。
   *
   * 同一份 applying intent 的落盘回执可能到达多次——公告结果落盘、主线程对账
   * 循环重跑都会为同一个 phase+intentId 再发一次回执——而 commitApply 是一次
   * 真实的 setChatPermissions。没有这面旗就会对同一轮重复写 Telegram：结果虽
   * 然幂等，却是白付的往返，也让「落盘回执后恰好 commit 一次」这条契约名存实亡。
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
  } & LockdownAnnouncement);

export type LockdownMachineEvent =
  | { type: "thresholdExceeded"; joinCount: number }
  | { type: "applyPrepared"; originalPermissions: ChatPermissions; joinCount: number; intentId: number }
  | { type: "applyPreparationFailed" }
  | { type: "applyCommitPreparationFailed" }
  | { type: "statePersisted"; phase: LockdownPhase; intentId: number }
  /**
   * 这一轮意图确定写不进 SQLite。持久化是「跨进程可恢复」的唯一凭据，失去它
   * 就不能再维持任何限制：占位直接撤销，已经落地的限制立刻恢复（见状态机
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
  /** 公告发送结果；messageId 只在发送成功时存在，供解除时定向删除。 */
  | { type: "announcementResult"; ok: boolean; messageId?: number }
  | {
    type: "adopt";
    phase: LockdownPhase;
    originalPermissions: ChatPermissions;
    intentId: number;
    announced: boolean;
    announcementMessageId?: number;
    remainingMs: number;
    persisted?: boolean;
  };

/**
 * 一轮私密模式被判定作废的原因；决定日志文案，也是「这一轮确实被放弃了」的
 * 唯一来源——冷却由状态机在真正作废的那条转移里发出，迟到或重复的失败通知
 * 撞上已经换代的状态时不会误伤健康的一轮。
 */
export type LockdownAbandonReason =
  | "preparationFailed"
  | "commitPreparationFailed"
  | "persistFailed";

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
  /** 占位一落地就发封锁公告；结果必须回投，不能把发送尝试当成发送成功。 */
  | { kind: "beginLockdownAnnouncement"; joinCount?: number }
  /** 本轮结束，删除群里那条封锁公告；只在确知 messageId 时发出。 */
  | { kind: "deleteLockdownAnnouncement"; messageId: number }
  /** 本轮作废：在冷却期内不再让入群把这个群重新推进私密模式。 */
  | { kind: "suppressRetrigger"; reason: LockdownAbandonReason; durationMs: number }
  | { kind: "announceUnlock" };

export interface LockdownTransition {
  /** 下一个状态：undefined = 删除记录；与传入同一对象 = 保持（计时器由 scheduleRestore 副作用管理）。 */
  next: LockdownState | undefined;
  effects: LockdownEffect[];
}
