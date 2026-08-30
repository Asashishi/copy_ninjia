import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../packages/consts/diskIO/common";
import {
  advanceTemporaryWhitelistActivity,
  isTemporaryWhitelistActive,
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
    expect(isTemporaryWhitelistActive(eighth)).toBeTrue();

    const ninth: Readonly<TemporaryWhitelistActivity> =
      advanceTemporaryWhitelistActivity(eighth, FIRST_DAY_AT + 8);
    expect(ninth).toMatchObject({ sendCount: 9, tempWhiteCount: 1 });
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
    expect(isTemporaryWhitelistActive(activity)).toBeTrue();
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
      tempWhiteAt: FIRST_DAY_AT + 7,
    });
  });

  test("未授权累计超过 24 小时重建，临时成员保留免检但连续日归零", () => {
    const qualified: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      8
    );
    expect(isTemporaryWhitelistActive(qualified)).toBeTrue();

    const retained: Readonly<TemporaryWhitelistActivity> =
      advanceTemporaryWhitelistActivity(
        qualified,
        qualified.countedAt + DAY_MS + 1
      );
    expect(retained).toEqual({
      tempWhite: true,
      tempWhiteAt: qualified.tempWhiteAt,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: qualified.countedAt + DAY_MS + 1,
      qualifiedAt: null,
    });

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
  });

  test("墙钟回拨时重建计数时间轴，但临时成员关系不撤销", () => {
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
    expect(isTemporaryWhitelistActive(active)).toBeTrue();
    expect(advanceTemporaryWhitelistActivity(active, FIRST_DAY_AT - 1)).toEqual({
      tempWhite: true,
      tempWhiteAt: active.tempWhiteAt,
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

  test("十万条同日发言保持单次合格日和稳定整数计数", () => {
    const activity: Readonly<TemporaryWhitelistActivity> = recordMessages(
      null,
      FIRST_DAY_AT,
      100_000
    );
    expect(activity).toMatchObject({
      tempWhite: true,
      tempWhiteCount: 1,
      sendCount: 100_000,
      qualifiedAt: FIRST_DAY_AT + 7,
    });
  });
});
