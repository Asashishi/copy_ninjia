import {
  TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_WHITELIST_INACTIVITY_TTL_MS,
  TEMPORARY_WHITELIST_REQUIRED_DAYS,
} from "../consts/temporaryWhitelist";
import { getTokyoDayIndex } from "../libs/time";
import type { TemporaryWhitelistActivity } from "../types/temporaryWhitelist";

/** 时间戳对应的记录是否仍处于滚动 24 小时有效期内。 */
function isTemporaryWhitelistActivityFresh(
  activity: Readonly<TemporaryWhitelistActivity>,
  now: number
): boolean {
  return Number.isSafeInteger(now) &&
    now >= activity.countedAt &&
    now - activity.countedAt <= TEMPORARY_WHITELIST_INACTIVITY_TTL_MS;
}

/** 当前记录是否提供临时广告检测豁免；首个合格日授权后只由显式删除撤销。 */
export function isTemporaryWhitelistActive(
  activity: Readonly<TemporaryWhitelistActivity>
): boolean {
  return activity.tempWhite;
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

/**
 * 计入一条跨群发言：首个合格日即时授予临时广告免检，单日只累计一次；
 * 连续第 7 个合格日把计数推进到自动永久免检门槛。成员关系在连续日断开时
 * 仍保留，只重置连续日计数，直到外层显式删除或完成永久免检晋升。
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
  if (
    now < current.countedAt ||
    !isTemporaryWhitelistActivityFresh(current, now)
  ) {
    return current.tempWhite
      ? {
        tempWhite: true,
        tempWhiteAt: current.tempWhiteAt,
        tempWhiteCount: 0,
        sendCount: 1,
        countedAt: now,
        qualifiedAt: null,
      }
      : firstActivity(now);
  }

  const currentDay: number = getTokyoDayIndex(now);
  const countedDay: number = getTokyoDayIndex(current.countedAt);
  if (currentDay !== countedDay) {
    const previousDayQualified: boolean = current.qualifiedAt !== null &&
      getTokyoDayIndex(current.qualifiedAt) === countedDay;
    return {
      tempWhite: current.tempWhite,
      tempWhiteAt: current.tempWhiteAt,
      tempWhiteCount: previousDayQualified ? current.tempWhiteCount : 0,
      sendCount: 1,
      countedAt: now,
      qualifiedAt: null,
    };
  }

  if (!Number.isSafeInteger(current.sendCount + 1)) {
    throw new RangeError("Temporary whitelist daily message count is exhausted.");
  }
  const sendCount: number = current.sendCount + 1;
  if (
    current.qualifiedAt !== null ||
    sendCount <= TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD
  ) {
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
