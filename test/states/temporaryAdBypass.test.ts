import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../packages/consts/time";
import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../../packages/consts/temporaryAdBypass";
import {
  advanceTemporaryAdBypassActivity,
  isTemporaryAdBypassActive,
  isTemporaryAdBypassActivityRetained,
  shouldPromoteToPermanentBypass,
} from "../../packages/states/temporaryAdBypass";
import type { TemporaryAdBypassActivity } from
  "../../packages/types/states/temporaryAdBypass";

const FIRST_DAY_AT: number = new Date("2026-08-01T12:00:00+09:00").getTime();
const QUALIFYING_MESSAGE_COUNT: number = TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1;
const FIRST_QUALIFIED_AT: number = FIRST_DAY_AT + TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD;

function recordMessages(
  current: Readonly<TemporaryAdBypassActivity> | null,
  startAt: number,
  count: number
): Readonly<TemporaryAdBypassActivity> {
  let activity: Readonly<TemporaryAdBypassActivity> | null = current;
  for (let index: number = 0; index < count; index++) {
    activity = advanceTemporaryAdBypassActivity(activity, startAt + index);
  }
  if (activity === null) throw new Error("recorded activity must exist");
  return activity;
}

describe("临时广告免检连续日状态机", () => {
  test("单日超过发言门槛只累计一次合格日", () => {
    const atThreshold: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD
    );
    expect(atThreshold).toMatchObject({
      sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
      qualifiedDays: 0,
      qualifiedAt: null,
      adBypass: false,
    });

    const qualified: Readonly<TemporaryAdBypassActivity> =
      advanceTemporaryAdBypassActivity(atThreshold, FIRST_QUALIFIED_AT);
    expect(qualified).toMatchObject({
      sendCount: QUALIFYING_MESSAGE_COUNT,
      qualifiedDays: 1,
      qualifiedAt: FIRST_QUALIFIED_AT,
      adBypass: true,
      adBypassGrantedAt: FIRST_QUALIFIED_AT,
    });
    expect(isTemporaryAdBypassActive(qualified, FIRST_QUALIFIED_AT)).toBeTrue();

    const extraMessage: Readonly<TemporaryAdBypassActivity> =
      advanceTemporaryAdBypassActivity(qualified, FIRST_QUALIFIED_AT + 1);
    expect(extraMessage).toBe(qualified);
  });

  test("当天达标后同日发言原样返回入参并冻结计数时刻", () => {
    const qualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    expect(qualified.countedAt).toBe(FIRST_QUALIFIED_AT);
    expect(qualified.qualifiedAt).toBe(FIRST_QUALIFIED_AT);

    let activity: Readonly<TemporaryAdBypassActivity> = qualified;
    for (let index: number = 1; index <= 64; index++) {
      activity = advanceTemporaryAdBypassActivity(activity, FIRST_QUALIFIED_AT + index);
      expect(activity).toBe(qualified);
    }
    expect(isTemporaryAdBypassActive(activity, FIRST_QUALIFIED_AT + 64)).toBeTrue();

    // 冻结值留在严格解码器与 SQLite CHECK 的合法域内。
    expect(activity).toEqual({
      adBypass: true,
      adBypassGrantedAt: FIRST_QUALIFIED_AT,
      qualifiedDays: 1,
      sendCount: QUALIFYING_MESSAGE_COUNT,
      countedAt: FIRST_QUALIFIED_AT,
      qualifiedAt: FIRST_QUALIFIED_AT,
    });
  });

  test("冻结期内墙钟回拨以达标时刻为重建阈值", () => {
    const qualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    // 回拨到达标之后：countedAt 冻结在达标那条发言上，按同日继续，不重建。
    expect(advanceTemporaryAdBypassActivity(qualified, FIRST_QUALIFIED_AT))
      .toBe(qualified);

    // 回拨到达标之前：仍重建计数时间轴，同时保留已授予的成员关系。
    expect(advanceTemporaryAdBypassActivity(qualified, FIRST_QUALIFIED_AT - 1)).toEqual({
      adBypass: true,
      adBypassGrantedAt: FIRST_QUALIFIED_AT - 1,
      qualifiedDays: 0,
      sendCount: 1,
      countedAt: FIRST_QUALIFIED_AT - 1,
      qualifiedAt: null,
    });
  });

  test("连续合格的配置时区自然日达到永久广告免检晋升门槛", () => {
    let activity: Readonly<TemporaryAdBypassActivity> | null = null;
    for (let day: number = 0; day < TEMPORARY_AD_BYPASS_REQUIRED_DAYS; day++) {
      activity = recordMessages(activity, FIRST_DAY_AT + day * DAY_MS, QUALIFYING_MESSAGE_COUNT);
      expect(shouldPromoteToPermanentBypass(activity)).toBe(day === TEMPORARY_AD_BYPASS_REQUIRED_DAYS - 1);
    }
    if (activity === null) throw new Error("qualified activity must exist");

    expect(activity).toMatchObject({
      adBypass: true,
      qualifiedDays: TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
      sendCount: QUALIFYING_MESSAGE_COUNT,
      adBypassGrantedAt: FIRST_QUALIFIED_AT,
    });
    expect(isTemporaryAdBypassActive(activity, activity.countedAt)).toBeTrue();
  });

  test("中间一天未超过发言门槛会在下一日重新累计连续日", () => {
    let activity: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    activity = recordMessages(activity, FIRST_DAY_AT + DAY_MS, TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD);
    activity = recordMessages(activity, FIRST_DAY_AT + 2 * DAY_MS, QUALIFYING_MESSAGE_COUNT);

    expect(activity).toMatchObject({
      adBypass: true,
      qualifiedDays: 1,
      sendCount: QUALIFYING_MESSAGE_COUNT,
      adBypassGrantedAt: FIRST_QUALIFIED_AT + 2 * DAY_MS,
    });
  });

  test("上一东京日达标时相邻日即使间隔超过 24 小时仍延续", () => {
    const qualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    const nextDayLate: number = new Date("2026-08-02T23:59:00+09:00").getTime();
    expect(nextDayLate - qualified.countedAt).toBeGreaterThan(DAY_MS);
    expect(isTemporaryAdBypassActive(qualified, nextDayLate)).toBeTrue();

    const retained: Readonly<TemporaryAdBypassActivity> =
      advanceTemporaryAdBypassActivity(
        qualified,
        nextDayLate
      );
    expect(retained).toEqual({
      adBypass: true,
      adBypassGrantedAt: qualified.adBypassGrantedAt,
      qualifiedDays: 1,
      sendCount: 1,
      countedAt: nextDayLate,
      qualifiedAt: null,
    });
    expect(isTemporaryAdBypassActive(retained, nextDayLate)).toBeTrue();
  });

  test("上一东京日未达标或跳日时撤销临时成员关系并重新累计", () => {
    const unqualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD
    );
    const restarted: Readonly<TemporaryAdBypassActivity> =
      advanceTemporaryAdBypassActivity(
        unqualified,
        unqualified.countedAt + DAY_MS + 1
      );
    expect(restarted).toEqual({
      adBypass: false,
      adBypassGrantedAt: null,
      qualifiedDays: 0,
      sendCount: 1,
      countedAt: unqualified.countedAt + DAY_MS + 1,
      qualifiedAt: null,
    });

    const qualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    const afterSkippedDay: number = FIRST_DAY_AT + 2 * DAY_MS;
    expect(isTemporaryAdBypassActive(qualified, afterSkippedDay)).toBeFalse();
    expect(advanceTemporaryAdBypassActivity(qualified, afterSkippedDay)).toEqual({
      adBypass: false,
      adBypassGrantedAt: null,
      qualifiedDays: 0,
      sendCount: 1,
      countedAt: afterSkippedDay,
      qualifiedAt: null,
    });
  });

  test("日期读取边界区分当天累计、上一日达标和失效旧行", () => {
    const qualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    expect(isTemporaryAdBypassActivityRetained(
      qualified,
      FIRST_QUALIFIED_AT
    )).toBeTrue();
    expect(isTemporaryAdBypassActivityRetained(
      qualified,
      FIRST_DAY_AT + DAY_MS
    )).toBeTrue();
    expect(isTemporaryAdBypassActivityRetained(
      qualified,
      FIRST_DAY_AT + 2 * DAY_MS
    )).toBeFalse();
    const unqualified: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD
    );
    expect(isTemporaryAdBypassActivityRetained(
      unqualified,
      FIRST_DAY_AT + DAY_MS
    )).toBeFalse();
  });

  test("墙钟回拨时重建计数时间轴并保留已授予资格", () => {
    const current: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      1
    );
    const active: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      QUALIFYING_MESSAGE_COUNT
    );
    expect(isTemporaryAdBypassActive(active, active.countedAt)).toBeTrue();
    expect(isTemporaryAdBypassActive(active, FIRST_DAY_AT - 1)).toBeTrue();
    expect(advanceTemporaryAdBypassActivity(active, FIRST_DAY_AT - 1)).toEqual({
      adBypass: true,
      adBypassGrantedAt: FIRST_DAY_AT - 1,
      qualifiedDays: 0,
      sendCount: 1,
      countedAt: FIRST_DAY_AT - 1,
      qualifiedAt: null,
    });
    expect(advanceTemporaryAdBypassActivity(current, FIRST_DAY_AT - 1)).toEqual({
      adBypass: false,
      adBypassGrantedAt: null,
      qualifiedDays: 0,
      sendCount: 1,
      countedAt: FIRST_DAY_AT - 1,
      qualifiedAt: null,
    });
  });

  test("十万条同日发言保持单次合格日和冻结后的稳定计数", () => {
    const activity: Readonly<TemporaryAdBypassActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      100_000
    );
    expect(activity).toMatchObject({
      adBypass: true,
      qualifiedDays: 1,
      sendCount: QUALIFYING_MESSAGE_COUNT,
      countedAt: FIRST_QUALIFIED_AT,
      qualifiedAt: FIRST_QUALIFIED_AT,
    });
  });
});
