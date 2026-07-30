import { afterEach, describe, expect, test } from "bun:test";
import {
  userReplyTriggerSweepState,
  userReplyTriggerTimes,
} from "../../packages/cache/main/auto";
import {
  USER_REPLY_TRIGGER_CACHE_MAX,
  USER_REPLY_TRIGGER_COOLDOWN_MS,
} from "../../packages/consts/auto";
import {
  clearUserReplyTriggerTimes,
  sweepUserReplyTriggerTimes,
  tryClaimUserReplyTrigger,
} from "../../packages/auto/message/triggerPolicy";

afterEach(clearUserReplyTriggerTimes);

describe("随机回复个人冷却", () => {
  test("小回拨立即失效未来点，新冷却仍按正常时长恢复", () => {
    const key = "-1001_7";
    userReplyTriggerTimes.set(key, 1_001);

    expect(tryClaimUserReplyTrigger(-1001, 7, 1_000)).toBeTrue();
    expect(tryClaimUserReplyTrigger(-1001, 7, 1_001)).toBeFalse();
    expect(tryClaimUserReplyTrigger(-1001, 7, 1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS)).toBeTrue();
  });

  test("大回拨不会让冷却长时冻结", () => {
    userReplyTriggerTimes.set("-1002_8", 9_999_999);
    expect(tryClaimUserReplyTrigger(-1002, 8, 10)).toBeTrue();
    expect(userReplyTriggerTimes.get("-1002_8")).toBe(10);
  });

  test("多名用户共用唯一清扫 timer，精确到期后统一删除", () => {
    expect(tryClaimUserReplyTrigger(-1001, 1, 1_000)).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | null =
      userReplyTriggerSweepState.timer;
    expect(timer).not.toBeNull();

    expect(tryClaimUserReplyTrigger(-1001, 2, 2_000)).toBeTrue();
    expect(userReplyTriggerSweepState.timer).toBe(timer);

    sweepUserReplyTriggerTimes(1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS);
    expect(userReplyTriggerTimes.has("-1001_1")).toBeFalse();
    expect(userReplyTriggerTimes.has("-1001_2")).toBeTrue();
  });

  test("达到硬顶后拒绝新随机 claim，清出过期空间后恢复", () => {
    for (let speakerId: number = 1; speakerId <= USER_REPLY_TRIGGER_CACHE_MAX; speakerId++) {
      expect(tryClaimUserReplyTrigger(-1001, speakerId, 1_000)).toBeTrue();
    }
    expect(userReplyTriggerTimes.size).toBe(USER_REPLY_TRIGGER_CACHE_MAX);
    expect(
      tryClaimUserReplyTrigger(
        -1001,
        USER_REPLY_TRIGGER_CACHE_MAX + 1,
        1_001
      )
    ).toBeFalse();
    expect(userReplyTriggerTimes.size).toBe(USER_REPLY_TRIGGER_CACHE_MAX);

    expect(
      tryClaimUserReplyTrigger(
        -1001,
        USER_REPLY_TRIGGER_CACHE_MAX + 1,
        1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS
      )
    ).toBeTrue();
    expect(userReplyTriggerTimes.size).toBe(1);
  });
});
