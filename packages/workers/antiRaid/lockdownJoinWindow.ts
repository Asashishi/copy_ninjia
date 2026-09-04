import {
  ANTI_RAID_PER_MINUTE_LIMIT,
  JOIN_WINDOW_CAPACITY,
  JOIN_WINDOW_MS,
  LOCKDOWN_MS,
} from "../../consts/antiRaid/lockdown";
import {
  joinWindows,
  lockdownRetriggerCooldowns,
} from "../../cache/workers/antiRaid/lockdown";
import { TimestampDeque } from "../../libs/timestampDeque";
import type { JoinWindow } from "../../types/antiRaid/internal";
import type { LockdownAbandonReason } from "../../types/states/lockdown";
import { logger } from "../../infra/logger";

/** 生成超过入群阈值时的封锁公告。 */
export function lockdownAnnouncementText(joinCount?: number): string {
  const influx: string = joinCount === undefined
    ? "检测到短时间内大量成员入群"
    : `${JOIN_WINDOW_MS / 1000} 秒内冲进来了 ${joinCount} 个杂鱼`;
  return `哼，${influx}，本天才怀疑是有人在拉人头，先禁止普通成员邀请新人 ${LOCKDOWN_MS / 60_000} 分钟压压惊♡`;
}

/** 丢弃某群的入群滑窗与静默清理计时器；重新计数从零开始。 */
export function clearJoinWindow(chatId: number): void {
  const window: JoinWindow | undefined = joinWindows.get(chatId);
  if (window === undefined) return;
  if (window.resetTimeout !== undefined) clearTimeout(window.resetTimeout);
  joinWindows.delete(chatId);
}

/** 删除某群的重触发冷却；群停用后重新开启时不得继承旧冷却。 */
export function clearJoinWindowCooldown(chatId: number): void {
  lockdownRetriggerCooldowns.delete(chatId);
}

/**
 * 每群只保留一个静默清理 timer。持续入群只更新 expiresAt；旧 timer 到点后若
 * 仍未静默，再按剩余时间续排，避免每条入群创建并立即丢弃 timer 与闭包。
 */
function scheduleJoinWindowCleanup(
  chatId: number,
  window: JoinWindow,
  delayMs: number
): void {
  window.resetTimeout = setTimeout((): void => {
    if (joinWindows.get(chatId) !== window) return;
    const remainingMs: number = window.expiresAt - Date.now();
    if (remainingMs > 0) {
      scheduleJoinWindowCleanup(chatId, window, remainingMs);
      return;
    }
    window.resetTimeout = undefined;
    joinWindows.delete(chatId);
  }, delayMs);
  window.resetTimeout.unref();
}

/** 冷却是否仍然生效；到期条目就地删除，避免长期占位。 */
function joinWindowCoolingDown(chatId: number, now: number): boolean {
  const until: number | undefined = lockdownRetriggerCooldowns.get(chatId);
  if (until === undefined) return false;
  if (now < until) return true;
  lockdownRetriggerCooldowns.delete(chatId);
  return false;
}

/**
 * 开始某群的重触发冷却。冷却比计数窗口长，期间记录在允许重触发前必然过期，
 * 因此立即释放窗口；写入时顺带清理其余过期冷却项。
 */
function suppressJoinWindowRetrigger(
  chatId: number,
  durationMs: number,
  now: number = Date.now()
): void {
  clearJoinWindow(chatId);
  for (const [cooledChatId, until] of lockdownRetriggerCooldowns) {
    if (now >= until) lockdownRetriggerCooldowns.delete(cooledChatId);
  }
  lockdownRetriggerCooldowns.set(chatId, now + durationMs);
}

/** 作废私密模式意图，并在冷却期内阻止相同系统故障反复触发。 */
export function beginLockdownRetriggerCooldown(
  chatId: number,
  reason: LockdownAbandonReason,
  durationMs: number
): void {
  suppressJoinWindowRetrigger(chatId, durationMs);
  logger.error(
    `Anti-raid lockdown for chat ${chatId} was abandoned (${reason}); ` +
    `suppressing new lockdown triggers there for ${durationMs / 60_000} minutes. ` +
    "Per-member join verification is unaffected."
  );
}

/**
 * 记录一次已确认的新成员加入。返回超过阈值时用于状态机的保守计数；未超过、
 * 或仍在作废冷却期时返回 undefined。
 *
 * 每群最多保留 JOIN_WINDOW_CAPACITY 个 number。超出时覆盖最早项，并用
 * overflowThrough 记住被覆盖数据尚未全部过期；异步撤销无法确认被覆盖项身份时
 * 保持 fail-safe 饱和，直到该时间段退出窗口。墙钟回拨会使未来的饱和证明失效，
 * 与 TimestampDeque.trim 丢弃未来记录的语义保持一致。
 */
export function recordJoinWindow(chatId: number, now: number): number | undefined {
  if (joinWindowCoolingDown(chatId, now)) return undefined;
  let window: JoinWindow | undefined = joinWindows.get(chatId);
  if (window === undefined) {
    window = {
      timestamps: new TimestampDeque(JOIN_WINDOW_CAPACITY, JOIN_WINDOW_CAPACITY),
      overflowThrough: undefined,
      expiresAt: now + JOIN_WINDOW_MS,
      resetTimeout: undefined,
    };
    joinWindows.set(chatId, window);
    scheduleJoinWindowCleanup(chatId, window, JOIN_WINDOW_MS);
  } else {
    window.expiresAt = now + JOIN_WINDOW_MS;
  }

  window.timestamps.trim(JOIN_WINDOW_MS, now);
  if (
    window.overflowThrough !== undefined &&
    (
      window.overflowThrough > now ||
      window.overflowThrough <= now - JOIN_WINDOW_MS
    )
  ) {
    window.overflowThrough = undefined;
  }
  const replacedAt: number | undefined = window.timestamps.pushReplacingOldest(now);
  if (replacedAt !== undefined) window.overflowThrough = replacedAt;
  const joinCount: number = window.overflowThrough === undefined
    ? window.timestamps.size
    : Math.max(window.timestamps.size, JOIN_WINDOW_CAPACITY);
  return joinCount > ANTI_RAID_PER_MINUTE_LIMIT ? joinCount : undefined;
}

/**
 * 按加入时刻撤销一次计数。找不到表示已过期、已清空，或在极端过载时被硬顶
 * 覆盖；最后一种保持饱和 fail-safe，直到被覆盖时间段退出窗口。
 */
export function retractJoinWindow(chatId: number, joinedAt: number): void {
  joinWindows.get(chatId)?.timestamps.removeValue(joinedAt);
}

/** Worker 停止时释放全部入群窗口 timer、窗口与重触发冷却。 */
export function stopJoinWindowRuntime(): void {
  for (const window of joinWindows.values()) {
    if (window.resetTimeout !== undefined) clearTimeout(window.resetTimeout);
  }
  joinWindows.clear();
  lockdownRetriggerCooldowns.clear();
}
