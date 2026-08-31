import {
  TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_WHITELIST_REQUIRED_DAYS,
} from "../consts/temporaryWhitelist";
import { getTokyoDayIndex } from "../libs/time";
import type { TemporaryWhitelistActivity } from "../types/temporaryWhitelist";

/** 记录是否尚未越过保留边界；未来时间轴留给下一条发言显式收敛。 */
export function isTemporaryWhitelistActivityRetained(
  activity: Readonly<TemporaryWhitelistActivity>,
  now: number = Date.now()
): boolean {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary whitelist activity time must be a non-negative safe integer.");
  }
  const currentDay: number = getTokyoDayIndex(now);
  const countedDay: number = getTokyoDayIndex(activity.countedAt);
  if (currentDay <= countedDay) return true;
  return currentDay === countedDay + 1 &&
    activity.qualifiedAt !== null &&
    getTokyoDayIndex(activity.qualifiedAt) === countedDay;
}

/** 当前记录是否仍提供临时广告检测豁免。 */
export function isTemporaryWhitelistActive(
  activity: Readonly<TemporaryWhitelistActivity>,
  now: number = Date.now()
): boolean {
  return activity.tempWhite &&
    isTemporaryWhitelistActivityRetained(activity, now);
}

function firstActivity(now: number): Readonly<TemporaryWhitelistActivity> {
  return {
    tempWhite: false,
    tempWhiteAt: null,
    tempWhiteCount: 0,
    sendCount: 1,
    countedAt: now,
    qualifiedAt: null,
  };
}

/** 墙钟回拨时从当前消息重建计数时间轴，同时保留已经授予的临时资格。 */
function restartActivityAfterClockRollback(
  current: Readonly<TemporaryWhitelistActivity>,
  now: number
): Readonly<TemporaryWhitelistActivity> {
  if (!current.tempWhite) return firstActivity(now);
  if (current.tempWhiteAt === null) {
    throw new Error("Temporary whitelist membership requires a grant timestamp.");
  }
  return {
    tempWhite: true,
    tempWhiteAt: Math.min(current.tempWhiteAt, now),
    tempWhiteCount: 0,
    sendCount: 1,
    countedAt: now,
    qualifiedAt: null,
  };
}

/**
 * 计入一条跨群发言：首个合格日即时授予临时广告免检，单日只累计一次；
 * 连续第 7 个合格日把计数推进到自动永久免检门槛。上一东京日未达标或中间
 * 跳日时从当前发言重新建立记录，不沿用旧成员关系或发言累计。
 *
 * 当天已达标后原样返回入参对象：`sendCount` 与 `countedAt` 不再进入任何保留、
 * 跨日或解码判定，冻结在达标那条发言上，调用方按引用相等跳过整条写回链路。
 * 由此墙钟回拨的重建阈值是「当天达标那条发言」而非「上一条发言」：回拨到达标
 * 时刻之前仍重建计数时间轴，回拨到达标之后按同日继续，成员关系两侧都保留。
 *
 * @see ../../docs/cn/04-invariants.md
 */
export function advanceTemporaryWhitelistActivity(
  current: Readonly<TemporaryWhitelistActivity> | null,
  now: number
): Readonly<TemporaryWhitelistActivity> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary whitelist activity time must be a non-negative safe integer.");
  }
  if (current === null) {
    return firstActivity(now);
  }
  const currentDay: number = getTokyoDayIndex(now);
  const countedDay: number = getTokyoDayIndex(current.countedAt);
  if (now < current.countedAt) {
    return restartActivityAfterClockRollback(current, now);
  }
  if (currentDay === countedDay + 1) {
    const previousDayQualified: boolean = current.qualifiedAt !== null &&
      getTokyoDayIndex(current.qualifiedAt) === countedDay;
    if (!previousDayQualified) return firstActivity(now);
    return {
      tempWhite: current.tempWhite,
      tempWhiteAt: current.tempWhiteAt,
      tempWhiteCount: current.tempWhiteCount,
      sendCount: 1,
      countedAt: now,
      qualifiedAt: null,
    };
  }
  if (currentDay !== countedDay) return firstActivity(now);
  if (current.qualifiedAt !== null) return current;

  if (!Number.isSafeInteger(current.sendCount + 1)) {
    throw new RangeError("Temporary whitelist daily message count is exhausted.");
  }
  const sendCount: number = current.sendCount + 1;
  if (sendCount <= TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD) {
    return { ...current, sendCount, countedAt: now };
  }

  const tempWhiteCount: number = Math.min(
    current.tempWhiteCount + 1,
    TEMPORARY_WHITELIST_REQUIRED_DAYS
  );
  return {
    tempWhite: true,
    tempWhiteAt: current.tempWhiteAt ?? now,
    tempWhiteCount,
    sendCount,
    countedAt: now,
    qualifiedAt: now,
  };
}
