import {
  LOCKDOWN_MS,
  LOCKDOWN_RETRIGGER_COOLDOWN_MS,
  RESTORE_RETRY_MS,
} from "../consts/antiRaid/lockdown";
import type { ChatPermissions } from "grammy/types";
import type {
  LockdownAbandonReason,
  LockdownAnnouncement,
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
 *   INACTIVE ──入群超阈值──────────────> APPLYING（占位 + 立刻发封锁公告）
 *   INACTIVE ──adopt（重启接管）────────> ACTIVE
 *   APPLYING ──intent 落盘、setChatPermissions 成功──> ACTIVE
 *   APPLYING ──setChatPermissions 抛错──> RESTORING（结果不确定，补一次恢复对账）
 *   APPLYING ──落盘失败────────────────> INACTIVE（从未改过权限，撤销占位）
 *   ACTIVE   ──到期恢复成功─────────────> INACTIVE
 *   ACTIVE   ──到期恢复失败─────────────> RESTORING（按 RESTORE_RETRY_MS 重试）
 *   ACTIVE   ──落盘失败────────────────> RESTORING（立刻恢复，不再等落盘）
 *   RESTORING ──重试恢复成功────────────> INACTIVE
 *   RESTORING ──期间再次超阈值──────────> ACTIVE（新一轮，倒计时重新给满）
 *   ACTIVE ──迟到恢复成功───────────────> RECONCILING（先落盘再重新收紧）
 *   RECONCILING ──纠偏成功──────────────> ACTIVE
 *   RECONCILING ──纠偏失败──────────────> RECONCILING（有界退避重试）
 *
 * APPLYING 的占位必须同步落地（thresholdExceeded 的转移是同步的）：真实
 * 刷群下同一批投递里越过阈值之后的每次入群都要立刻走「私密模式直接踢出」
 * 分支，且反复触发不重复调用 API。APPLYING 期间恢复计时器
 * 到期也绝不能拿空的 originalPermissions 去「恢复」——setChatPermissions
 * 会把省略的字段全部当 false，等于把全群禁言——只能按短间隔轮询等落地。
 *
 * 封锁公告与占位同刻发出：占位一落地，新进群的人（包括被群友拉进来的）就会
 * 被直接请出去，群里必须同时看到「为什么进不来人」。公告的 messageId 随状态
 * 持久化，本轮结束时定向删除；发送结果比本轮活得更久时（加锁失败、期间被
 * 解除）由 announcementResult 在 INACTIVE 上直接删除，绝不留孤儿公告。
 * announced/announcementMessageId 的完整语义见 types/states/lockdown.ts。
 *
 * 落盘失败（persistFailed）一律 fail-safe 打开：持久化是「崩溃后还有人能恢复
 * 这条限制」的唯一凭据，写不进去就不能继续锁着群。占位阶段直接撤销，已经
 * 落地的限制立刻发起恢复，不再等落盘回执。
 *
 * 一轮封锁的时长上限就是 LOCKDOWN_MS：恢复时刻在进入 ACTIVE 那一刻定死，
 * 期间再怎么灌人也不会把它推后。刷群持续时，5 分钟到点先真的解除（权限还
 * 回去、公告删掉、发解除通知），窗口若仍越阈值再由下一条入群开启新的一轮，
 * 而不是让同一轮无限续期——那正是「过了 5 分钟也没解除」的另一半成因。
 *
 * 恢复调用在途期间若新峰值把状态从 RESTORING 推回 ACTIVE（新一轮给满倒计时）：
 * 稍后到达的 restoreResult 按其真实结果处理——
 *   - 失败：忽略（那次尝试对应的是旧的 RESTORING，权限从未恢复过，ACTIVE
 *     与其满额计时器原样保留，到期自然再次尝试）；
 *   - 成功：权限确实已经被这次旧尝试恢复成「未限制」了，但当前意图仍是
 *     ACTIVE（新峰值要求继续锁定）——不能当成解锁处理，否则镜像/公告都会
 *     跟真实权限脱节；必须进入可持久化的 RECONCILING，确认重新关闭 invite
 *     字段后才能回到 ACTIVE。失败结果同样回投并重试，不能把远端未确认当成功。
 */

/** 本轮公告的记账原样带到下一阶段：公告属于「这一轮封锁」，不属于某个阶段。 */
function announcementOf(state: LockdownState): LockdownAnnouncement {
  return {
    announced: state.announced,
    announcementPending: state.announcementPending,
    announcementMessageId: state.announcementMessageId,
  };
}

/** 本轮结束时撤掉群里那条封锁公告；ID 未知（没发成功或还在途）就不删。 */
function announcementCleanupEffects(state: LockdownState): LockdownEffect[] {
  return state.announcementMessageId === undefined
    ? []
    : [{ kind: "deleteLockdownAnnouncement", messageId: state.announcementMessageId }];
}

/**
 * 本轮作废时压制重触发。只在真正作废的那条转移里发出：作废判定要看当前状态，
 * 迟到或重复的失败通知撞上已经换代的状态时不得连累健康的那一轮。
 */
function suppressRetrigger(reason: LockdownAbandonReason): LockdownEffect {
  return { kind: "suppressRetrigger", reason, durationMs: LOCKDOWN_RETRIGGER_COOLDOWN_MS };
}

/** APPLYING 的 preparing 阶段还没有 intent，主线程无从落盘（见 publishLockdownState）。 */
function isPersistable(state: LockdownState): boolean {
  return state.kind !== "applying" || state.stage === "prepared";
}

export function transitionLockdown(state: LockdownState | undefined, event: LockdownMachineEvent): LockdownTransition {
  switch (event.type) {
    case "thresholdExceeded": {
      if (state === undefined) {
        return {
          next: {
            kind: "applying",
            stage: "preparing",
            announced: false,
            announcementPending: true,
            announcementMessageId: undefined,
          },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: true },
            // 公告排在读权限之前：从这一刻起入群就会被请出去，群里不能没有交代。
            { kind: "beginLockdownAnnouncement", joinCount: event.joinCount },
            { kind: "prepareApply", joinCount: event.joinCount },
          ],
        };
      }
      const effects: LockdownEffect[] = [{ kind: "prefetchAdmins", onlyIfCold: true }];
      if (state.kind === "restoring") {
        // 恢复已经在跑（到期或显式解除），新峰值把它拉回 ACTIVE：这是新的一轮，
        // 重新给满一个 LOCKDOWN_MS 并落盘新的截止时刻。回到 ACTIVE 不重发封锁
        // 公告（下面没有 beginLockdownAnnouncement），公告记账原样带过来。
        effects.push({ kind: "scheduleRestore", delayMs: LOCKDOWN_MS }, { kind: "persistState" });
        return {
          next: {
            kind: "active",
            originalPermissions: state.originalPermissions,
            intentId: state.intentId,
            ...announcementOf(state),
          },
          effects,
        };
      }
      // ACTIVE / RECONCILING / APPLYING 期间再次超阈值只预热管理员表：本轮的
      // 恢复时刻在进入 ACTIVE 时就定死了，倒计时既不重排也不重新落盘。
      return { next: state, effects };
    }
    case "applyPrepared":
      if (state?.kind !== "applying" || state.stage !== "preparing") {
        return { next: state, effects: [] };
      }
      return {
        next: {
          kind: "applying",
          stage: "prepared",
          originalPermissions: event.originalPermissions,
          joinCount: event.joinCount,
          intentId: event.intentId,
          commitStarted: false,
          ...announcementOf(state),
        },
        effects: [{ kind: "persistState" }],
      };
    case "applyPreparationFailed":
      if (state?.kind !== "applying" || state.stage !== "preparing") {
        return { next: state, effects: [] };
      }
      // 从未形成 intent、也从未改过 Telegram：撤销占位，并撤掉刚发出去的公告。
      return {
        next: undefined,
        effects: [...announcementCleanupEffects(state), suppressRetrigger("preparationFailed")],
      };
    case "applyCommitPreparationFailed":
      if (state?.kind !== "applying" || state.stage !== "prepared") {
        return { next: state, effects: [] };
      }
      // applying intent 已经落盘，但 Telegram 写操作尚未开始；删除 owner 即可，
      // 不能走恢复路径，否则可能用 T0 快照覆盖管理员刚改过的 invite 权限。
      return {
        next: undefined,
        effects: [
          { kind: "reportUnlock" },
          ...announcementCleanupEffects(state),
          suppressRetrigger("commitPreparationFailed"),
        ],
      };
    case "statePersisted": {
      if (state?.kind !== event.phase) return { next: state, effects: [] };
      if (state.kind === "applying") {
        if (
          state.stage !== "prepared" ||
          state.intentId !== event.intentId ||
          // 同一份 intent 的落盘回执可能到达多次（公告结果落盘、主线程对账
          // 重跑），但 commitApply 是一次真实的 setChatPermissions。
          state.commitStarted
        ) {
          return { next: state, effects: [] };
        }
        return { next: { ...state, commitStarted: true }, effects: [{ kind: "commitApply" }] };
      }
      if (state.intentId !== event.intentId) return { next: state, effects: [] };
      if (state.kind === "restoring" && state.restoreAfterPersist) {
        return {
          next: { ...state, restoreAfterPersist: false },
          effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }],
        };
      }
      if (state.kind === "reconciling" && state.reapplyAfterPersist) {
        return {
          next: { ...state, reapplyAfterPersist: false },
          effects: [{ kind: "beginReapply" }],
        };
      }
      return { next: state, effects: [] };
    }
    case "persistFailed": {
      if (state?.kind !== event.phase) return { next: state, effects: [] };
      if (state.kind === "applying") {
        if (state.stage !== "prepared" || state.intentId !== event.intentId) {
          return { next: state, effects: [] };
        }
        // intent 写不进 SQLite，而 Telegram 还没被改过：这一轮当作从未发生。
        return {
          next: undefined,
          effects: [
            { kind: "reportUnlock" },
            ...announcementCleanupEffects(state),
            suppressRetrigger("persistFailed"),
          ],
        };
      }
      if (state.intentId !== event.intentId) return { next: state, effects: [] };
      if (state.kind === "restoring") {
        // 本来就等着落盘回执去恢复：回执永远不会来了，直接恢复。
        if (!state.restoreAfterPersist) return { next: state, effects: [] };
        return {
          next: { ...state, restoreAfterPersist: false },
          effects: [
            { kind: "beginRestore", originalPermissions: state.originalPermissions },
            suppressRetrigger("persistFailed"),
          ],
        };
      }
      // ACTIVE / RECONCILING：限制已经落在群上，却再也无法跨进程恢复——
      // 立刻恢复原权限，绝不留一条没人能解除的限制（见类头注释）。
      return {
        next: {
          kind: "restoring",
          originalPermissions: state.originalPermissions,
          intentId: state.intentId,
          restoreAfterPersist: false,
          ...announcementOf(state),
        },
        effects: [
          { kind: "beginRestore", originalPermissions: state.originalPermissions },
          suppressRetrigger("persistFailed"),
        ],
      };
    }
    case "applyResult":
      if (state?.kind !== "applying" || state.stage !== "prepared") {
        return { next: state, effects: [] };
      }
      if (!event.ok) {
        // 写操作结果不确定（可能已经生效），补一次恢复对账。公告在 APPLYING
        // 就发过了，因此记账原样带走：恢复成功时该不该发解锁公告由它决定。
        return {
          next: {
            kind: "restoring",
            originalPermissions: state.originalPermissions,
            intentId: event.restoreIntentId,
            restoreAfterPersist: true,
            ...announcementOf(state),
          },
          effects: [{ kind: "persistState" }],
        };
      }
      return {
        next: {
          kind: "active",
          originalPermissions: state.originalPermissions,
          intentId: state.intentId,
          ...announcementOf(state),
        },
        effects: [
          { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
          { kind: "persistState" },
        ],
      };
    case "restoreTimerFired":
      if (state?.kind !== "active" && state?.kind !== "reconciling") {
        return { next: state, effects: [] };
      }
      return {
        next: {
          kind: "restoring",
          originalPermissions: state.originalPermissions,
          intentId: event.intentId,
          restoreAfterPersist: true,
          ...announcementOf(state),
        },
        effects: [{ kind: "persistState" }],
      };
    case "restoreRetryFired":
      if (state?.kind !== "restoring") return { next: state, effects: [] };
      return { next: state, effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }] };
    case "reapplyRetryFired":
      if (state?.kind !== "reconciling") return { next: state, effects: [] };
      return { next: state, effects: [{ kind: "beginReapply" }] };
    case "deactivate": {
      if (state === undefined) return { next: state, effects: [] };
      if (state.kind === "applying" && state.stage === "preparing") {
        // 尚未形成 intent、更没改过 Telegram，直接撤销占位并撤掉公告即可。
        return { next: undefined, effects: announcementCleanupEffects(state) };
      }
      const originalPermissions: ChatPermissions =
        state.originalPermissions;
      return {
        next: {
          kind: "restoring",
          originalPermissions,
          intentId: event.intentId,
          restoreAfterPersist: true,
          ...announcementOf(state),
        },
        effects: [{ kind: "persistState" }],
      };
    }
    case "restoreResult": {
      if (state === undefined || state.kind === "applying") return { next: state, effects: [] };
      if (event.ok) {
        if (state.kind === "active") {
          // 迟到的旧恢复尝试成功了：真实权限刚被这次旧尝试恢复成「未限制」，
          // 但新峰值已经要求继续锁定（见类头注释）——原地补一次限制，
          // 先把「远端现在已开放、需要重新收紧」持久化；落盘回执后才执行纠偏，
          // Worker 或进程在两步之间崩溃也能从 RECONCILING 幂等接上。
          return {
            next: {
              kind: "reconciling",
              originalPermissions: state.originalPermissions,
              intentId: state.intentId,
              reapplyAfterPersist: true,
              ...announcementOf(state),
            },
            effects: [{ kind: "persistState" }],
          };
        }
        if (state.kind === "reconciling") return { next: state, effects: [] };
        return {
          next: undefined,
          effects: state.announced
            ? [
              { kind: "reportUnlock" },
              ...announcementCleanupEffects(state),
              { kind: "announceUnlock" },
            ]
            : [{ kind: "reportUnlock" }, ...announcementCleanupEffects(state)],
        };
      }
      if (state.kind === "active" || state.kind === "reconciling") {
        // 这次失败回执对应的是旧的恢复尝试：它在途期间新峰值已把状态从
        // RESTORING 推回 ACTIVE/RECONCILING 并给满新倒计时（见 thresholdExceeded）。
        // 权限现在按锁定意图仍应保持限制，忽略这条迟到的失败——
        // 不打断刚延长的倒计时，到期后会自然重新发起一次恢复。
        return { next: state, effects: [] };
      }
      return { next: state, effects: [{ kind: "scheduleRestoreRetry", delayMs: RESTORE_RETRY_MS }] };
    }
    case "reapplyResult": {
      if (state?.kind !== "reconciling") return { next: state, effects: [] };
      if (!event.ok) {
        return {
          next: state,
          effects: [{ kind: "scheduleReapplyRetry", delayMs: RESTORE_RETRY_MS }],
        };
      }
      return {
        next: {
          kind: "active",
          originalPermissions: state.originalPermissions,
          intentId: state.intentId,
          ...announcementOf(state),
        },
        effects: [{ kind: "persistState" }],
      };
    }
    case "announcementResult": {
      if (state === undefined) {
        // 本轮在公告落地前就结束了（加锁失败、或期间被解除）：这条消息从此
        // 没有任何状态记得它，只能在拿到 ID 的此刻直接删掉。
        return {
          next: state,
          effects: event.ok && event.messageId !== undefined
            ? [{ kind: "deleteLockdownAnnouncement", messageId: event.messageId }]
            : [],
        };
      }
      if (!state.announcementPending) return { next: state, effects: [] };
      if (!event.ok) return { next: { ...state, announcementPending: false }, effects: [] };
      const next: LockdownState = {
        ...state,
        announced: true,
        announcementPending: false,
        announcementMessageId: event.messageId,
      };
      return { next, effects: isPersistable(next) ? [{ kind: "persistState" }] : [] };
    }
    case "adopt": {
      if (state !== undefined) return { next: state, effects: [] };
      // 上一代那次发送的结局已无从追认：接管方只认落盘下来的 announced 与
      // messageId。落盘说「没公告过」而锁定仍要继续时补一次公告——群里必须
      // 知道自己为什么进不来人；RESTORING 正在收尾，补公告只会前言不搭后语。
      const announceOnAdopt: boolean = !event.announced && event.phase !== "restoring";
      const announcement: LockdownAnnouncement = {
        announced: event.announced,
        announcementPending: announceOnAdopt,
        announcementMessageId: event.announcementMessageId,
      };
      const announceEffects: LockdownEffect[] = announceOnAdopt
        ? [{ kind: "beginLockdownAnnouncement" }]
        : [];
      if (event.phase === "applying") {
        return {
          next: {
            kind: "applying",
            stage: "prepared",
            originalPermissions: event.originalPermissions,
            intentId: event.intentId,
            // 下面立刻发 commitApply 的那一路必须同时置位，否则补发公告带来的
            // 那次落盘回执会让同一轮再写一次 Telegram。
            commitStarted: event.persisted !== false,
            ...announcement,
          },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: false },
            ...announceEffects,
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
            restoreAfterPersist: event.persisted === false,
            ...announcement,
          },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: false },
            ...(event.persisted === false
              ? []
              : [{ kind: "beginRestore", originalPermissions: event.originalPermissions } as const]),
          ],
        };
      }
      if (event.phase === "reconciling") {
        return {
          next: {
            kind: "reconciling",
            originalPermissions: event.originalPermissions,
            intentId: event.intentId,
            reapplyAfterPersist: event.persisted === false,
            ...announcement,
          },
          effects: [
            { kind: "prefetchAdmins", onlyIfCold: false },
            ...announceEffects,
            { kind: "scheduleRestore", delayMs: event.remainingMs },
            ...(event.persisted === false
              ? []
              : [{ kind: "beginReapply" } as const]),
          ],
        };
      }
      return {
        next: {
          kind: "active",
          originalPermissions: event.originalPermissions,
          intentId: event.intentId,
          ...announcement,
        },
        effects: [
          { kind: "prefetchAdmins", onlyIfCold: false },
          ...announceEffects,
          { kind: "scheduleRestore", delayMs: event.remainingMs },
        ],
      };
    }
  }
}
