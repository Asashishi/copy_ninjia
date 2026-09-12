import {
  handleApplyCommitPreparationFailed,
  handleApplyPrepared,
  handleApplyPreparationFailed,
  handleApplyResult,
  handleThresholdExceeded,
} from "./lockdown/apply";
import { handleAdopt } from "./lockdown/adopt";
import { handleAnnouncementResult } from "./lockdown/announcement";
import { handlePersistFailed, handleStatePersisted } from "./lockdown/persistence";
import {
  handleDeactivate,
  handleReapplyResult,
  handleReapplyRetryFired,
  handleRestoreResult,
  handleRestoreRetryFired,
  handleRestoreTimerFired,
} from "./lockdown/restore";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../types/states/lockdown";

/**
 * 反刷群私密模式的纯状态转移入口；状态与副作用归 antiRaid Worker。
 * apply / persistence / restore / announcement / adopt 处理对应事件，本文件穷尽路由。
 * 跨线程持久化、公告及迟到结果约束见 docs/cn/04-invariants.md。
 *
 * INACTIVE 表示没有该群状态；adopt 可接管任一持久化阶段。
 *
 *   INACTIVE ──thresholdExceeded──> APPLYING preparing
 *   APPLYING preparing ──applyPrepared──> APPLYING prepared
 *   APPLYING prepared ──落盘回执、加锁成功──> ACTIVE
 *   APPLYING prepared ──加锁结果不确定──> RESTORING
 *   APPLYING ──提交未派发、准备或持久化失败──> INACTIVE
 *   APPLYING ──提交已派发、持久化失败──> RESTORING
 *   ACTIVE / RECONCILING ──到期或解除──> RESTORING
 *   RESTORING ──恢复成功──> INACTIVE
 *   RESTORING ──再次超阈值──> RESTORING
 *   ACTIVE ──迟到恢复成功──> RECONCILING
 *   RECONCILING ──重新收紧成功──> ACTIVE
 *
 * 恢复或重新收紧失败时保留对应阶段并重试；持久化失败按当前阶段发出补偿效果。
 */
export function transitionLockdown(
  state: LockdownState | undefined,
  event: LockdownMachineEvent
): LockdownTransition {
  switch (event.type) {
    case "thresholdExceeded":
      return handleThresholdExceeded(state, event);
    case "applyPrepared":
      return handleApplyPrepared(state, event);
    case "applyPreparationFailed":
      return handleApplyPreparationFailed(state);
    case "applyCommitPreparationFailed":
      return handleApplyCommitPreparationFailed(state);
    case "statePersisted":
      return handleStatePersisted(state, event);
    case "persistFailed":
      return handlePersistFailed(state, event);
    case "applyResult":
      return handleApplyResult(state, event);
    case "restoreTimerFired":
      return handleRestoreTimerFired(state, event);
    case "restoreRetryFired":
      return handleRestoreRetryFired(state);
    case "reapplyRetryFired":
      return handleReapplyRetryFired(state);
    case "deactivate":
      return handleDeactivate(state, event);
    case "restoreResult":
      return handleRestoreResult(state, event);
    case "reapplyResult":
      return handleReapplyResult(state, event);
    case "announcementResult":
      return handleAnnouncementResult(state, event);
    case "adopt":
      return handleAdopt(state, event);
  }
}
