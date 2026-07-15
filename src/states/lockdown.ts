import type { ChatPermissions } from "@grammyjs/types";
import { LOCKDOWN_MS, RESTORE_RETRY_MS } from "../consts/antiRaid";

/**
 * 反刷群私密模式生命周期的显式状态机（纯逻辑，不做任何 I/O、不持有计时器）。
 * 状态按 chatId 归属，由 workers/antiRaidWorker.ts 持有并解释执行。
 *
 * 状态图（INACTIVE = Map 里没有这个 chatId）：
 *
 *   INACTIVE ──入群超阈值──────────────> APPLYING（占位，权限限制尚未落地）
 *   INACTIVE ──adopt（重启接管）────────> ACTIVE
 *   APPLYING ──setChatPermissions 成功──> ACTIVE
 *   APPLYING ──setChatPermissions 失败──> INACTIVE
 *   ACTIVE   ──到期恢复成功─────────────> INACTIVE
 *   ACTIVE   ──到期恢复失败─────────────> RESTORING（按 RESTORE_RETRY_MS 重试）
 *   RESTORING ──重试恢复成功────────────> INACTIVE
 *   RESTORING ──期间再次超阈值──────────> ACTIVE（倒计时重新给满）
 *
 * APPLYING 的占位必须同步落地（thresholdExceeded 的转移是同步的）：真实
 * 刷群下同一批投递里越过阈值之后的每次入群都要立刻走「私密模式直接踢出」
 * 分支，且反复触发只延长倒计时、不重复调用 API。APPLYING 期间恢复计时器
 * 到期也绝不能拿空的 originalPermissions 去「恢复」——setChatPermissions
 * 会把省略的字段全部当 false，等于把全群禁言——只能按短间隔轮询等落地。
 *
 * 恢复调用在途期间若新峰值把状态从 RESTORING 推回 ACTIVE（倒计时给满）：
 * 稍后到达的 restoreResult 按其真实结果处理——成功仍会解除锁定（权限确实
 * 已经恢复了，记录必须跟着删，否则镜像与真实权限脱节；延长的那个计时器
 * 随记录一起清掉）；失败则忽略（那次尝试对应的是旧的 RESTORING，权限从
 * 未恢复过，ACTIVE 与其满额计时器原样保留，到期自然再次尝试）。
 */

export type LockdownState =
  | { kind: "applying" }
  | { kind: "active"; originalPermissions: ChatPermissions }
  | { kind: "restoring"; originalPermissions: ChatPermissions };

export type LockdownMachineEvent =
  | { type: "thresholdExceeded"; joinCount: number }
  /** beginApply 副作用的回执；成功时带取到的原始权限与触发时的入群数（通知文案用）。 */
  | { type: "applyResult"; ok: true; originalPermissions: ChatPermissions; joinCount: number }
  | { type: "applyResult"; ok: false }
  | { type: "restoreTimerFired" }
  /** beginRestore 副作用的回执。 */
  | { type: "restoreResult"; ok: boolean }
  /** Worker 崩溃重启 / 进程重启后接管仍在生效的私密模式（权限已实际落在群上）。 */
  | { type: "adopt"; originalPermissions: ChatPermissions };

export type LockdownEffect =
  /** 预热管理员表：锁定期内「管理员拉人免验证」只认同步缓存判定。 */
  | { kind: "prefetchAdmins"; onlyIfCold: boolean }
  /** 异步执行 getChat + setChatPermissions（禁拉人），结果以 applyResult 回投。 */
  | { kind: "beginApply"; joinCount: number }
  /** （重新）安排恢复计时器，到期投递 restoreTimerFired。 */
  | { kind: "scheduleRestore"; delayMs: number }
  /** 异步恢复原始权限，结果以 restoreResult 回投。 */
  | { kind: "beginRestore"; originalPermissions: ChatPermissions }
  /** 回报主线程写入 ChatState.lockdown 镜像并持久化（只该出现真正生效了的锁定）。 */
  | { kind: "reportLockdown"; originalPermissions: ChatPermissions }
  | { kind: "reportUnlock" }
  | { kind: "announceLockdown"; joinCount: number }
  | { kind: "announceUnlock" };

export interface LockdownTransition {
  /** 下一个状态：undefined = 删除记录；与传入同一对象 = 保持（计时器由 scheduleRestore 副作用管理）。 */
  next: LockdownState | undefined;
  effects: LockdownEffect[];
}

export function transitionLockdown(state: LockdownState | undefined, event: LockdownMachineEvent): LockdownTransition {
  switch (event.type) {
    case "thresholdExceeded": {
      if (state !== undefined) {
        // 入群高峰仍在持续：只把倒计时重新给满，不重复调 API、不重复发通知。
        // 持续刷群会反复触发到这里，管理员缓存过期后也能被重新拉热。
        const effects: LockdownEffect[] = [
          { kind: "prefetchAdmins", onlyIfCold: true },
          { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
        ];
        const next: LockdownState = state.kind === "restoring" ? { kind: "active", originalPermissions: state.originalPermissions } : state;
        return { next, effects };
      }
      return {
        next: { kind: "applying" },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: true },
          { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
          { kind: "beginApply", joinCount: event.joinCount },
        ],
      };
    }
    case "applyResult": {
      // APPLYING 是唯一会有 beginApply 在途的状态，其它分支正常不可达（防御）。
      if (state?.kind !== "applying") return { next: state, effects: [] };
      if (!event.ok) return { next: undefined, effects: [] };
      return {
        next: { kind: "active", originalPermissions: event.originalPermissions },
        effects: [
          // 限制此刻才真正落地：占位期的计时可能已在限流队列里耗掉大半，
          // 从生效时刻重新起算满额，不然锁定可能在落地后几十秒内就被解除。
          { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
          { kind: "reportLockdown", originalPermissions: event.originalPermissions },
          { kind: "announceLockdown", joinCount: event.joinCount },
        ],
      };
    }
    case "restoreTimerFired": {
      if (state === undefined) return { next: state, effects: [] };
      if (state.kind === "applying") {
        // 限制根本没落地（getChat/setChatPermissions 还在限流队列里排队）：
        // 按短间隔轮询，等 applyResult 落定。
        return { next: state, effects: [{ kind: "scheduleRestore", delayMs: RESTORE_RETRY_MS }] };
      }
      return {
        next: state.kind === "restoring" ? state : { kind: "restoring", originalPermissions: state.originalPermissions },
        effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }],
      };
    }
    case "restoreResult": {
      if (state === undefined || state.kind === "applying") return { next: state, effects: [] };
      if (event.ok) return { next: undefined, effects: [{ kind: "reportUnlock" }, { kind: "announceUnlock" }] };
      if (state.kind === "active") {
        // 这次失败回执对应的是旧的恢复尝试：它在途期间新峰值已把状态从
        // RESTORING 推回 ACTIVE 并给满新倒计时（见 thresholdExceeded）。
        // 权限现在按 ACTIVE 的意图仍应保持锁定，忽略这条迟到的失败——
        // 不打断刚延长的倒计时，到期后会自然重新发起一次恢复。
        return { next: state, effects: [] };
      }
      // 恢复失败绝不能删记录：记录没了、无人重试，群的 can_invite_users 就
      // 永久卡在 false。保留并稍后重试；重试期间私密模式仍然生效（unlock
      // 事件也尚未发出），与「权限实际仍被限制着」的事实一致。
      return { next: state, effects: [{ kind: "scheduleRestore", delayMs: RESTORE_RETRY_MS }] };
    }
    case "adopt": {
      if (state !== undefined) return { next: state, effects: [] };
      // 崩溃前已过去多久无从得知，计时满额重开——宁可多锁一会儿也不能不解锁。
      // 接管的记录直接视为已生效：镜像里只会出现权限已实际落地的私密模式。
      return {
        next: { kind: "active", originalPermissions: event.originalPermissions },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
        ],
      };
    }
  }
}
