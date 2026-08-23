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
  claimRandomMediaTrigger,
  clearUserReplyTriggerTimes,
  sweepUserReplyTriggerTimes,
  tryClaimUserReplyTrigger,
} from "../../packages/auto/message/triggerPolicy";
import type { MessageTriggerContext } from "../../packages/types/auto";

/** 只带随机掷骰与冷却判定所需字段的最小上下文；其余字段本组用例不读。 */
function triggerContextAt(now: number, chatId: number = -1001): MessageTriggerContext {
  return {
    chatId,
    now,
    isQuiet: false,
    hasOtherMention: false,
    repliesToSelf: false,
    directTriggerReason: undefined,
    // 概率取 1，让掷骰必中，把用例聚焦在冷却判定本身。
    aiReplyProbability: 1,
  } as unknown as MessageTriggerContext;
}

afterEach(clearUserReplyTriggerTimes);

describe("随机回复个人冷却", () => {
  test("小回拨立即失效未来点，新冷却仍按正常时长恢复", () => {
    const key = "-1001:7";
    userReplyTriggerTimes.set(key, 1_001);

    expect(tryClaimUserReplyTrigger(-1001, 7, 1_000)).toBeTrue();
    expect(tryClaimUserReplyTrigger(-1001, 7, 1_001)).toBeFalse();
    expect(tryClaimUserReplyTrigger(-1001, 7, 1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS)).toBeTrue();
  });

  test("大回拨不会让冷却长时冻结", () => {
    userReplyTriggerTimes.set("-1002:8", 9_999_999);
    expect(tryClaimUserReplyTrigger(-1002, 8, 10)).toBeTrue();
    expect(userReplyTriggerTimes.get("-1002:8")).toBe(10);
  });

  test("多名用户共用唯一清扫 timer，精确到期后统一删除", () => {
    expect(tryClaimUserReplyTrigger(-1001, 1, 1_000)).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | null =
      userReplyTriggerSweepState.timer;
    expect(timer).not.toBeNull();

    expect(tryClaimUserReplyTrigger(-1001, 2, 2_000)).toBeTrue();
    expect(userReplyTriggerSweepState.timer).toBe(timer);

    sweepUserReplyTriggerTimes(1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS);
    expect(userReplyTriggerTimes.has("-1001:1")).toBeFalse();
    expect(userReplyTriggerTimes.has("-1001:2")).toBeTrue();
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

  /**
   * 冷却必须按**本条消息的 now** 计时，而不是让被调方自己再读一次墙钟。
   *
   * 两个理由，缺一不可：语义上，同一条消息的活跃度入窗、安静期判定与这次冷却
   * 认领必须落在同一时刻（见 auto/message/index.ts 的「本条消息统一的『现在』」）；
   * 性能上，这台部署机的 clocksource 是 kvm-clock，实测在带真实工作集的函数里
   * 多读一次墙钟约 3 µs（syscall 本身约 0.87 µs，其余是它对缓存的污染），
   * 是这条判定其余部分的几十倍。
   */
  test("媒体随机掷骰的冷却按上下文的 now 计时，不读墙钟", () => {
    const base: number = 1_767_225_600_000;

    expect(claimRandomMediaTrigger(triggerContextAt(base), 7)).toBe("claimed");
    expect(userReplyTriggerTimes.get("-1001:7")).toBe(base);

    // 冷却未到期：即便墙钟早已走过，判定仍只认上下文里的 now。
    expect(claimRandomMediaTrigger(triggerContextAt(base + USER_REPLY_TRIGGER_COOLDOWN_MS - 1), 7))
      .toBe("candidate");
    expect(userReplyTriggerTimes.get("-1001:7")).toBe(base);

    // 恰好到期：重新认领，并把冷却起点推到这条消息的 now。
    const renewed: number = base + USER_REPLY_TRIGGER_COOLDOWN_MS;
    expect(claimRandomMediaTrigger(triggerContextAt(renewed), 7)).toBe("claimed");
    expect(userReplyTriggerTimes.get("-1001:7")).toBe(renewed);
  });

  test("掷骰没中时不占用冷却名额，也不落任何条目", () => {
    const base: number = 1_767_225_600_000;
    const context: MessageTriggerContext = triggerContextAt(base);
    // 概率归零即必不中；没中就是 "none"，不会往下走冷却认领那一步。
    (context as { aiReplyProbability: number }).aiReplyProbability = 0;

    expect(claimRandomMediaTrigger(context, 7)).toBe("none");
    expect(userReplyTriggerTimes.size).toBe(0);
  });
});
