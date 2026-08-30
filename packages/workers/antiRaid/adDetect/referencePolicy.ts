/** 引用类广告的五分钟警告升级状态；状态 owner 为 Anti-Raid Worker。 */

import {
  referencedAdWarningGeneration,
  referencedAdWarningStates,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_REFERENCE_WARNING_WINDOW_MS,
} from "../../../consts/antiRaid/adDetect";
import { logger } from "../../../infra/logger";
import {
  parseVerificationKey,
  verificationKeyPrefix,
} from "../../../libs/verificationKey";
import type { ReferencedAdWarningState } from "../../../types/antiRaid/adDetect";

/** 为一个首次警告建立唯一发送 attempt；undefined 表示序号已经不可安全递增。 */
export function beginReferencedAdWarning(key: string): number | undefined {
  const nextGeneration: number = referencedAdWarningGeneration.current + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    logger.error("Referenced ad warning generation space is exhausted.");
    return undefined;
  }
  referencedAdWarningGeneration.current = nextGeneration;
  referencedAdWarningStates.delete(key);
  if (referencedAdWarningStates.size >= AD_DETECT_MAX_PENDING_SENDERS) {
    const oldestKey: string | undefined =
      referencedAdWarningStates.keys().next().value;
    if (oldestKey !== undefined) referencedAdWarningStates.delete(oldestKey);
  }
  referencedAdWarningStates.set(key, {
    phase: "sending",
    generation: nextGeneration,
  });
  return nextGeneration;
}

/**
 * 把仍匹配当前 attempt 的发送态提交为五分钟警告态。清群、关闭或新 attempt
 * 已经替换它时返回 false，调用方只能清理迟到提示，不得建立升级窗口。
 */
export function completeReferencedAdWarning(
  key: string,
  generation: number,
  warnedAt: number
): boolean {
  const current: ReferencedAdWarningState | undefined =
    referencedAdWarningStates.get(key);
  if (
    current?.phase !== "sending" ||
    current.generation !== generation
  ) return false;
  referencedAdWarningStates.set(key, {
    phase: "warned",
    generation,
    warnedAt,
    expiresAt: warnedAt + AD_REFERENCE_WARNING_WINDOW_MS,
  });
  return true;
}

/** 发送失败时只撤销匹配的 attempt，不能误删同 key 后来建立的新状态。 */
export function cancelReferencedAdWarning(
  key: string,
  generation: number
): void {
  const current: ReferencedAdWarningState | undefined =
    referencedAdWarningStates.get(key);
  if (
    current?.phase === "sending" &&
    current.generation === generation
  ) referencedAdWarningStates.delete(key);
}

/**
 * 消息到达时冻结它是否处于已公开警告窗口。处理队列可能延迟超过五分钟，之后
 * 的判定只读冻结事实，不再拿处理时钟推翻消息真正到达时的状态。
 */
export function hasActiveReferencedAdWarning(key: string, receivedAt: number): boolean {
  const state: ReferencedAdWarningState | undefined =
    referencedAdWarningStates.get(key);
  if (state?.phase !== "warned") return false;
  if (receivedAt >= state.warnedAt && receivedAt < state.expiresAt) return true;
  // 走到这里只剩两种情况：窗口已过，或 receivedAt 早于 warnedAt——后者只能由墙钟
  // 回拨造成，继续保留会把五分钟升级窗拉长。两种都直接回收，不再重复判一次条件。
  referencedAdWarningStates.delete(key);
  return false;
}

/** 引用类广告升级为 block 后清掉旧警告，避免无用途地占着容量。 */
export function clearReferencedAdWarning(key: string): void {
  referencedAdWarningStates.delete(key);
}

/** 停管或关闭广告检测时清掉该群的全部发送中/已警告状态。 */
export function clearChatReferencedAdWarnings(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  for (const key of referencedAdWarningStates.keys()) {
    if (key.startsWith(prefix)) referencedAdWarningStates.delete(key);
  }
}

/** 某身份获得白名单权限时，清掉它在各群的引用广告警告状态。 */
export function clearIdentityReferencedAdWarnings(identityId: number): void {
  for (const key of referencedAdWarningStates.keys()) {
    if (parseVerificationKey(key)?.userId === identityId) {
      referencedAdWarningStates.delete(key);
    }
  }
}

/** 周期回收已过期警告；发送中的 attempt 由发送结算、清群或 Worker 停止清理。 */
export function sweepReferencedAdWarnings(now: number): void {
  for (const [key, state] of referencedAdWarningStates) {
    if (state.phase !== "warned") continue;
    const elapsedMs: number = now - state.warnedAt;
    if (elapsedMs < 0 || now >= state.expiresAt) {
      referencedAdWarningStates.delete(key);
    }
  }
}

/** Worker 停止时清空全部引用类广告警告状态；attempt 序号不得回退。 */
export function resetReferencedAdWarnings(): void {
  referencedAdWarningStates.clear();
}
