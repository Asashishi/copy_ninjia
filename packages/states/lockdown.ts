import { LOCKDOWN_MS, RESTORE_RETRY_MS } from "../consts/antiRaid/lockdown";
import type {
  LockdownEffect,
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../types/states/lockdown";

/**
 * 反刷群私密模式生命周期的显式状态机（纯逻辑，不做任何 I/O、不持有计时器）。
 * 状态按 chatId 归属，由 workers/antiRaidWorker.ts 持有并解释执行。
 *
 * 状态图（INACTIVE = Map 里没有这个 chatId）：
 *
 *   INACTIVE ──入群超阈值──────────────> APPLYING（占位，权限限制尚未落地）
 *   INACTIVE ──adopt（重启接管）────────> ACTIVE
 *   APPLYING ──intent 落盘、setChatPermissions 成功──> ACTIVE（并发出封锁公告）
 *   APPLYING ──setChatPermissions 抛错──> RESTORING（结果不确定，补一次恢复对账）
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
 * announced 标志沿 ACTIVE ──> RESTORING 传递，也带过 RESTORING ──再次超阈值──>
 * ACTIVE 这条回头路（那一步不重发封锁公告，因此不能在那里重置）。它决定解锁
 * 公告发不发，完整理由与落盘取舍见 docs/04-invariants.md 的「状态机契约」。
 *
 * 恢复调用在途期间若新峰值把状态从 RESTORING 推回 ACTIVE（倒计时给满）：
 * 稍后到达的 restoreResult 按其真实结果处理——
 *   - 失败：忽略（那次尝试对应的是旧的 RESTORING，权限从未恢复过，ACTIVE
 *     与其满额计时器原样保留，到期自然再次尝试）；
 *   - 成功：权限确实已经被这次旧尝试恢复成「未限制」了，但当前意图仍是
 *     ACTIVE（新峰值要求继续锁定）——不能当成解锁处理，否则镜像/公告都会
 *     跟真实权限脱节；必须原地补一次限制（reapplyRestriction 在当前 Telegram
 *     权限上重新关闭 invite 字段），状态与计时器都不变。
 */

export function transitionLockdown(state: LockdownState | undefined, event: LockdownMachineEvent): LockdownTransition {
  switch (event.type) {
    case "thresholdExceeded": {
      if (state === undefined) {
        return {
          next: { kind: "applying" },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: true },
            { kind: "prepareApply", joinCount: event.joinCount },
          ],
        };
      }
      const effects: LockdownEffect[] = [{ kind: "prefetchAdmins", onlyIfCold: true }];
      if (state.kind === "active" || state.kind === "restoring") {
        const next: LockdownState = state.kind === "active"
          ? state
          : {
            kind: "active",
            originalPermissions: state.originalPermissions,
            intentId: state.intentId,
            // 回到 ACTIVE 不会重发封锁公告（下面没有 announceLockdown），
            // 因此「公告过没有」原样带过来，不能在这里重置成 true。
            announced: state.announced,
          };
        effects.push({ kind: "scheduleRestore", delayMs: LOCKDOWN_MS }, { kind: "persistState" });
        return { next, effects };
      }
      return { next: state, effects };
    }
    case "applyPrepared":
      if (state?.kind !== "applying" || state.originalPermissions !== undefined) return { next: state, effects: [] };
      return {
        next: {
          kind: "applying",
          originalPermissions: event.originalPermissions,
          joinCount: event.joinCount,
          intentId: event.intentId,
        },
        effects: [{ kind: "persistState" }],
      };
    case "applyPreparationFailed":
      if (state?.kind !== "applying" || state.originalPermissions !== undefined) return { next: state, effects: [] };
      return { next: undefined, effects: [] };
    case "applyCommitPreparationFailed":
      if (state?.kind !== "applying" || state.originalPermissions === undefined) return { next: state, effects: [] };
      // applying intent 已经落盘，但 Telegram 写操作尚未开始；删除 owner 即可，
      // 不能走恢复路径，否则可能用 T0 快照覆盖管理员刚改过的 invite 权限。
      return { next: undefined, effects: [{ kind: "reportUnlock" }] };
    case "statePersisted":
      if (state?.kind !== event.phase || state.intentId !== event.intentId) return { next: state, effects: [] };
      if (state.kind === "applying" && state.originalPermissions !== undefined) {
        return { next: state, effects: [{ kind: "commitApply" }] };
      }
      if (state.kind === "restoring") {
        return { next: state, effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }] };
      }
      return { next: state, effects: [] };
    case "applyResult":
      if (state?.kind !== "applying" || state.originalPermissions === undefined || state.intentId === undefined) {
        return { next: state, effects: [] };
      }
      if (!event.ok) {
        // 写操作结果不确定（可能已经生效），补一次恢复对账。这一路从未公告过，
        // 恢复成功时也就不该发解锁公告。
        return {
          next: {
            kind: "restoring",
            originalPermissions: state.originalPermissions,
            intentId: event.restoreIntentId,
            announced: false,
          },
          effects: [{ kind: "persistState" }],
        };
      }
      return {
        next: { kind: "active", originalPermissions: state.originalPermissions, intentId: state.intentId, announced: true },
        effects: [
          { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
          { kind: "persistState" },
          {
            kind: "announceLockdown",
            ...(state.joinCount === undefined ? {} : { joinCount: state.joinCount }),
          },
        ],
      };
    case "restoreTimerFired":
      if (state?.kind !== "active") return { next: state, effects: [] };
      return {
        next: {
          kind: "restoring",
          originalPermissions: state.originalPermissions,
          intentId: event.intentId,
          announced: state.announced,
        },
        effects: [{ kind: "persistState" }],
      };
    case "restoreRetryFired":
      if (state?.kind !== "restoring") return { next: state, effects: [] };
      return { next: state, effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }] };
    case "deactivate":
      if (state === undefined) return { next: state, effects: [] };
      if (state.kind === "applying" && state.originalPermissions === undefined) {
        // 尚未形成 intent、更没改过 Telegram，直接撤销占位即可。
        return { next: undefined, effects: [] };
      }
      return {
        next: {
          kind: "restoring",
          originalPermissions: state.originalPermissions!,
          intentId: event.intentId,
          // 从 APPLYING 被解除：加锁公告还没发出去过。
          announced: state.kind === "applying" ? false : state.announced,
        },
        effects: [{ kind: "persistState" }],
      };
    case "restoreResult": {
      if (state === undefined || state.kind === "applying") return { next: state, effects: [] };
      if (event.ok) {
        if (state.kind === "active") {
          // 迟到的旧恢复尝试成功了：真实权限刚被这次旧尝试恢复成「未限制」，
          // 但新峰值已经要求继续锁定（见类头注释）——原地补一次限制，
          // 状态/计时器都不动，不当成解锁处理。
          return { next: state, effects: [{ kind: "reapplyRestriction", originalPermissions: state.originalPermissions }] };
        }
        return {
          next: undefined,
          effects: state.announced
            ? [{ kind: "reportUnlock" }, { kind: "announceUnlock" }]
            : [{ kind: "reportUnlock" }],
        };
      }
      if (state.kind === "active") {
        // 这次失败回执对应的是旧的恢复尝试：它在途期间新峰值已把状态从
        // RESTORING 推回 ACTIVE 并给满新倒计时（见 thresholdExceeded）。
        // 权限现在按 ACTIVE 的意图仍应保持锁定，忽略这条迟到的失败——
        // 不打断刚延长的倒计时，到期后会自然重新发起一次恢复。
        return { next: state, effects: [] };
      }
      return { next: state, effects: [{ kind: "scheduleRestoreRetry", delayMs: RESTORE_RETRY_MS }] };
    }
    case "adopt": {
      if (state !== undefined) return { next: state, effects: [] };
      if (event.phase === "applying") {
        return {
          next: { kind: "applying", originalPermissions: event.originalPermissions, intentId: event.intentId },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: false },
            ...(event.persisted === false
              ? []
              : [{ kind: "commitApply" } as const]),
          ],
        };
      }
      if (event.phase === "restoring") {
        return {
          next: {
            kind: "restoring",
            originalPermissions: event.originalPermissions,
            intentId: event.intentId,
            // 持久化记录不带 announced（见 types/states/lockdown.ts）。RESTORING
            // 绝大多数来自「ACTIVE 到期」，那条路公告过；只有「加锁抛错后崩溃、
            // 重启才接管」这条复合罕见路径会因此多发一句解锁公告。取常见的那一侧。
            announced: true,
          },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: false },
            ...(event.persisted === false
              ? []
              : [{ kind: "beginRestore", originalPermissions: event.originalPermissions } as const]),
          ],
        };
      }
      return {
        // 落盘的 ACTIVE 意味着上个进程加锁成功过，而加锁成功必然伴随封锁公告。
        next: { kind: "active", originalPermissions: event.originalPermissions, intentId: event.intentId, announced: true },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          { kind: "scheduleRestore", delayMs: event.remainingMs },
        ],
      };
    }
  }
}
