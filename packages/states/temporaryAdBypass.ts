import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../consts/temporaryAdBypass";
import { getTokyoDayIndex } from "../libs/time";
import type { TemporaryAdBypassActivity } from "../types/states/temporaryAdBypass";

/**
 * 记录是否尚未越过保留边界；未来时间轴留给下一条发言显式收敛。
 *
 * `now` 必填：本模块与同目录其余判定一样不读时钟，墙钟由调用方一次取好传进来
 * （见 infra/identityPolicy/temporaryAdBypass.ts），同一条消息的多次判定因此用
 * 同一个时刻。
 */
export function isTemporaryAdBypassActivityRetained(
  activity: Readonly<TemporaryAdBypassActivity>,
  now: number
): boolean {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary ad bypass activity time must be a non-negative safe integer.");
  }
  const currentDay: number = getTokyoDayIndex(now);
  const countedDay: number = getTokyoDayIndex(activity.countedAt);
  if (currentDay <= countedDay) return true;
  return currentDay === countedDay + 1 &&
    activity.qualifiedAt !== null &&
    getTokyoDayIndex(activity.qualifiedAt) === countedDay;
}

/** 当前记录是否仍提供临时广告检测豁免；`now` 由调用方给出，理由同上。 */
export function isTemporaryAdBypassActive(
  activity: Readonly<TemporaryAdBypassActivity>,
  now: number
): boolean {
  return activity.adBypass &&
    isTemporaryAdBypassActivityRetained(activity, now);
}

/**
 * 记录是否已到自动永久免检门槛：连续合格日数等于
 * TEMPORARY_AD_BYPASS_REQUIRED_DAYS（`advanceTemporaryAdBypassActivity` 把连续
 * 日数封顶在该门槛）。调用方据此晋升永久白名单并清除临时累计。
 */
export function shouldPromoteToPermanentBypass(
  activity: Readonly<TemporaryAdBypassActivity>
): boolean {
  return activity.qualifiedDays === TEMPORARY_AD_BYPASS_REQUIRED_DAYS;
}

function firstActivity(now: number): Readonly<TemporaryAdBypassActivity> {
  return {
    adBypass: false,
    adBypassGrantedAt: null,
    qualifiedDays: 0,
    sendCount: 1,
    countedAt: now,
    qualifiedAt: null,
  };
}

/** 墙钟回拨时从当前消息重建计数时间轴，同时保留已经授予的临时资格。 */
function restartActivityAfterClockRollback(
  current: Readonly<TemporaryAdBypassActivity>,
  now: number
): Readonly<TemporaryAdBypassActivity> {
  if (!current.adBypass) return firstActivity(now);
  if (current.adBypassGrantedAt === null) {
    throw new Error("Temporary ad bypass membership requires a grant timestamp.");
  }
  return {
    adBypass: true,
    adBypassGrantedAt: Math.min(current.adBypassGrantedAt, now),
    qualifiedDays: 0,
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
export function advanceTemporaryAdBypassActivity(
  current: Readonly<TemporaryAdBypassActivity> | null,
  now: number
): Readonly<TemporaryAdBypassActivity> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary ad bypass activity time must be a non-negative safe integer.");
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
      adBypass: current.adBypass,
      adBypassGrantedAt: current.adBypassGrantedAt,
      qualifiedDays: current.qualifiedDays,
      sendCount: 1,
      countedAt: now,
      qualifiedAt: null,
    };
  }
  if (currentDay !== countedDay) return firstActivity(now);
  if (current.qualifiedAt !== null) return current;

  if (!Number.isSafeInteger(current.sendCount + 1)) {
    throw new RangeError("Temporary ad bypass daily message count is exhausted.");
  }
  const sendCount: number = current.sendCount + 1;
  if (sendCount <= TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD) {
    return {
      adBypass: current.adBypass,
      adBypassGrantedAt: current.adBypassGrantedAt,
      qualifiedDays: current.qualifiedDays,
      sendCount,
      countedAt: now,
      qualifiedAt: current.qualifiedAt,
    };
  }

  const qualifiedDays: number = Math.min(
    current.qualifiedDays + 1,
    TEMPORARY_AD_BYPASS_REQUIRED_DAYS
  );
  return {
    adBypass: true,
    adBypassGrantedAt: current.adBypassGrantedAt ?? now,
    qualifiedDays,
    sendCount,
    countedAt: now,
    qualifiedAt: now,
  };
}
