import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../packages/consts/diskIO/common";
import { TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD } from
  "../../packages/consts/temporaryWhitelist";
import {
  advanceTemporaryWhitelistActivity,
  isTemporaryWhitelistActive,
  isTemporaryWhitelistActivityRetained,
} from "../../packages/states/temporaryWhitelist";
import type { TemporaryWhitelistActivity } from
  "../../packages/types/temporaryWhitelist";

const FIRST_DAY_AT: number = new Date("2026-08-01T12:00:00+09:00").getTime();

function recordMessages(
  current: Readonly<TemporaryWhitelistActivity> | null,
  startAt: number,
  count: number
): Readonly<TemporaryWhitelistActivity> {
  let activity: Readonly<TemporaryWhitelistActivity> | null = current;
  for (let index: number = 0; index < count; index++) {
    activity = advanceTemporaryWhitelistActivity(activity, startAt + index);
  }
  if (activity === null) throw new Error("recorded activity must exist");
  return activity;
}

describe("临时白名单连续日状态机", () => {
  test("单日第 8 条只累计一次合格日", () => {
    const firstSeven: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      7
    );
    expect(firstSeven).toMatchObject({
      sendCount: 7,
      tempWhiteCount: 0,
      qualifiedAt: null,
      tempWhite: false,
    });

    const eighth: Readonly<TemporaryWhitelistActivity> =
      advanceTemporaryWhitelistActivity(firstSeven, FIRST_DAY_AT + 7);
    expect(eighth).toMatchObject({
      sendCount: 8,
      tempWhiteCount: 1,
      qualifiedAt: FIRST_DAY_AT + 7,
      tempWhite: true,
      tempWhiteAt: FIRST_DAY_AT + 7,
    });
    expect(isTemporaryWhitelistActive(eighth, FIRST_DAY_AT + 7)).toBeTrue();

    const ninth: Readonly<TemporaryWhitelistActivity> =
      advanceTemporaryWhitelistActivity(eighth, FIRST_DAY_AT + 8);
    expect(ninth).toBe(eighth);
  });

  test("当天达标后同日发言原样返回入参并冻结计数时刻", () => {
    const qualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    expect(qualified.countedAt).toBe(FIRST_DAY_AT + 7);
    expect(qualified.qualifiedAt).toBe(FIRST_DAY_AT + 7);

    let activity: Readonly<TemporaryWhitelistActivity> = qualified;
    for (let index: number = 8; index < 64; index++) {
      activity = advanceTemporaryWhitelistActivity(activity, FIRST_DAY_AT + index);
      expect(activity).toBe(qualified);
    }
    expect(isTemporaryWhitelistActive(activity, FIRST_DAY_AT + 63)).toBeTrue();

    // 冻结值必须留在严格解码器与 SQLite CHECK 的合法域内。
    expect(activity).toEqual({
      tempWhite: true,
      tempWhiteAt: FIRST_DAY_AT + 7,
      tempWhiteCount: 1,
      sendCount: TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD + 1,
      countedAt: FIRST_DAY_AT + 7,
      qualifiedAt: FIRST_DAY_AT + 7,
    });
  });

  test("冻结期内墙钟回拨以达标时刻为重建阈值", () => {
    const qualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    // 回拨到达标之后：countedAt 冻结在达标那条发言上，按同日继续，不重建。
    expect(advanceTemporaryWhitelistActivity(qualified, FIRST_DAY_AT + 7))
      .toBe(qualified);

    // 回拨到达标之前：仍重建计数时间轴，同时保留已授予的成员关系。
    expect(advanceTemporaryWhitelistActivity(qualified, FIRST_DAY_AT + 6)).toEqual({
      tempWhite: true,
      tempWhiteAt: FIRST_DAY_AT + 6,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: FIRST_DAY_AT + 6,
      qualifiedAt: null,
    });
  });

  test("连续 7 个东京自然日都超过 7 条时到达永久广告免检晋升门槛", () => {
    let activity: Readonly<TemporaryWhitelistActivity> | null = null;
    for (let day: number = 0; day < 7; day++) {
      activity = recordMessages(activity, FIRST_DAY_AT + day * DAY_MS, 8);
    }
    if (activity === null) throw new Error("seven-day activity must exist");

    expect(activity).toMatchObject({
      tempWhite: true,
      tempWhiteCount: 7,
      sendCount: 8,
      tempWhiteAt: FIRST_DAY_AT + 7,
    });
    expect(isTemporaryWhitelistActive(activity, activity.countedAt)).toBeTrue();
  });

  test("中间一天未超过 7 条会在下一日重新累计连续日", () => {
    let activity: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    activity = recordMessages(activity, FIRST_DAY_AT + DAY_MS, 7);
    activity = recordMessages(activity, FIRST_DAY_AT + 2 * DAY_MS, 8);

    expect(activity).toMatchObject({
      tempWhite: true,
      tempWhiteCount: 1,
      sendCount: 8,
      tempWhiteAt: FIRST_DAY_AT + 2 * DAY_MS + 7,
    });
  });

  test("上一东京日达标时相邻日即使间隔超过 24 小时仍延续", () => {
    const qualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    const nextDayLate: number = new Date("2026-08-02T23:59:00+09:00").getTime();
    expect(nextDayLate - qualified.countedAt).toBeGreaterThan(DAY_MS);
    expect(isTemporaryWhitelistActive(qualified, nextDayLate)).toBeTrue();

    const retained: Readonly<TemporaryWhitelistActivity> =
      advanceTemporaryWhitelistActivity(
        qualified,
        nextDayLate
      );
    expect(retained).toEqual({
      tempWhite: true,
      tempWhiteAt: qualified.tempWhiteAt,
      tempWhiteCount: 1,
      sendCount: 1,
      countedAt: nextDayLate,
      qualifiedAt: null,
    });
    expect(isTemporaryWhitelistActive(retained, nextDayLate)).toBeTrue();
  });

  test("上一东京日未达标或跳日时撤销临时成员关系并重新累计", () => {
    const unqualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      7
    );
    const restarted: Readonly<TemporaryWhitelistActivity> =
      advanceTemporaryWhitelistActivity(
        unqualified,
        unqualified.countedAt + DAY_MS + 1
      );
    expect(restarted).toEqual({
      tempWhite: false,
      tempWhiteAt: null,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: unqualified.countedAt + DAY_MS + 1,
      qualifiedAt: null,
    });

    const qualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    const afterSkippedDay: number = FIRST_DAY_AT + 2 * DAY_MS;
    expect(isTemporaryWhitelistActive(qualified, afterSkippedDay)).toBeFalse();
    expect(advanceTemporaryWhitelistActivity(qualified, afterSkippedDay)).toEqual({
      tempWhite: false,
      tempWhiteAt: null,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: afterSkippedDay,
      qualifiedAt: null,
    });
  });

  test("日期读取边界区分当天累计、上一日达标和失效旧行", () => {
    const qualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    expect(isTemporaryWhitelistActivityRetained(
      qualified,
      FIRST_DAY_AT + 7
    )).toBeTrue();
    expect(isTemporaryWhitelistActivityRetained(
      qualified,
      FIRST_DAY_AT + DAY_MS
    )).toBeTrue();
    expect(isTemporaryWhitelistActivityRetained(
      qualified,
      FIRST_DAY_AT + 2 * DAY_MS
    )).toBeFalse();
    const unqualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      7
    );
    expect(isTemporaryWhitelistActivityRetained(
      unqualified,
      FIRST_DAY_AT + DAY_MS
    )).toBeFalse();
  });

  test("墙钟回拨时重建计数时间轴并保留已授予资格", () => {
    const current: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      1
    );
    const active: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    expect(isTemporaryWhitelistActive(active, active.countedAt)).toBeTrue();
    expect(isTemporaryWhitelistActive(active, FIRST_DAY_AT - 1)).toBeTrue();
    expect(advanceTemporaryWhitelistActivity(active, FIRST_DAY_AT - 1)).toEqual({
      tempWhite: true,
      tempWhiteAt: FIRST_DAY_AT - 1,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: FIRST_DAY_AT - 1,
      qualifiedAt: null,
    });
    expect(advanceTemporaryWhitelistActivity(current, FIRST_DAY_AT - 1)).toEqual({
      tempWhite: false,
      tempWhiteAt: null,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: FIRST_DAY_AT - 1,
      qualifiedAt: null,
    });
  });

  test("十万条同日发言保持单次合格日和冻结后的稳定计数", () => {
    const activity: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      100_000
    );
    expect(activity).toMatchObject({
      tempWhite: true,
      tempWhiteCount: 1,
      sendCount: TEMPORARY_WHITELIST_DAILY_MESSAGE_THRESHOLD + 1,
      countedAt: FIRST_DAY_AT + 7,
      qualifiedAt: FIRST_DAY_AT + 7,
    });
  });
});
