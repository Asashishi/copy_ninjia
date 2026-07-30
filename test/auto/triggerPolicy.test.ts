import { afterEach, describe, expect, test } from "bun:test";
import { userReplyTriggerTimes } from "../../packages/cache/main/auto";
import { USER_REPLY_TRIGGER_COOLDOWN_MS } from "../../packages/consts/auto";
import { tryClaimUserReplyTrigger } from "../../packages/auto/message/triggerPolicy";

afterEach(() => { userReplyTriggerTimes.clear(); });

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
});
