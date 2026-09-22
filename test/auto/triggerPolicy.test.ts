import { afterEach, describe, expect, jest, test } from "bun:test";
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

afterEach((): void => {
  clearUserReplyTriggerTimes();
  jest.useRealTimers();
});

describe("随机回复个人冷却", () => {
  function fill(now: number): void {
    for (let userId: number = 1; userId <= USER_REPLY_TRIGGER_CACHE_MAX; userId++) {
      expect(tryClaimUserReplyTrigger(-1001, userId, now)).toBeTrue();
    }
  }

  test("满表有效区间拒绝新键且不淘汰现有冷却，精确到期后恢复", (): void => {
    fill(1_000);
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 1_001)).toBeFalse();
    expect(userReplyTriggerSweepState.validUntil).toBe(1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS);
    const before: [string, number][] = [...userReplyTriggerTimes];
    for (let index: number = 0; index < 100; index++) {
      expect(tryClaimUserReplyTrigger(-1001, 100_000 + index, 1_002 + index)).toBeFalse();
    }
    expect([...userReplyTriggerTimes]).toEqual(before);
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS)).toBeTrue();
    expect(userReplyTriggerTimes.size).toBe(1);
  });

  test("满表续期后回拨到旧有效区间，仍清理跨键未来冷却", (): void => {
    fill(1_000);
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 1_500)).toBeFalse();
    expect(tryClaimUserReplyTrigger(-1001, 1, 1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS)).toBeTrue();
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 1_501)).toBeTrue();
    expect(userReplyTriggerTimes.has("-1001:1")).toBeFalse();
    expect(userReplyTriggerTimes.get("-1001:2")).toBe(1_000);
    expect(userReplyTriggerTimes.size).toBe(USER_REPLY_TRIGGER_CACHE_MAX);
  });

  test("跨键时钟回拨离开有效区间时补扫，部分到期只释放过期名额", (): void => {
    expect(tryClaimUserReplyTrigger(-1001, 1, 1_000)).toBeTrue();
    for (let userId: number = 2; userId <= USER_REPLY_TRIGGER_CACHE_MAX; userId++) {
      expect(tryClaimUserReplyTrigger(-1001, userId, 2_000)).toBeTrue();
    }
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 2_001)).toBeFalse();
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 1_000 + USER_REPLY_TRIGGER_COOLDOWN_MS)).toBeTrue();
    expect(userReplyTriggerTimes.has("-1001:1")).toBeFalse();
    expect(userReplyTriggerTimes.get("-1001:2")).toBe(2_000);
    expect(userReplyTriggerTimes.size).toBe(USER_REPLY_TRIGGER_CACHE_MAX);
    expect(tryClaimUserReplyTrigger(-1001, 100_001, 1_999)).toBeTrue();
    expect(userReplyTriggerTimes.size).toBe(1);
  });

  test("显式清扫与清空使旧满表判定失效，重新填表使用新时间轴", (): void => {
    fill(1_000);
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 1_001)).toBeFalse();
    sweepUserReplyTriggerTimes(999);
    expect(userReplyTriggerTimes.size).toBe(0);
    fill(900);
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 950)).toBeFalse();
    clearUserReplyTriggerTimes();
    expect(userReplyTriggerSweepState.timer).toBeNull();
    fill(800);
    expect(tryClaimUserReplyTrigger(-1001, 100_000, 799)).toBeTrue();
    expect(userReplyTriggerTimes.size).toBe(1);
  });
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

  test("唯一清扫 timer 到点后重排下一次：先到期的名额被删，后到期的等到它自己那一刻", (): void => {
    const base: number = Date.parse("2026-03-01T00:00:00Z");
    jest.useFakeTimers({ now: base });

    expect(tryClaimUserReplyTrigger(-1001, 1, Date.now())).toBeTrue();
    jest.advanceTimersByTime(500);
    expect(tryClaimUserReplyTrigger(-1001, 2, Date.now())).toBeTrue();
    expect(userReplyTriggerSweepState.timer).not.toBeNull();

    jest.advanceTimersByTime(USER_REPLY_TRIGGER_COOLDOWN_MS - 500);
    expect(userReplyTriggerTimes.has("-1001:1")).toBeFalse();
    expect(userReplyTriggerTimes.has("-1001:2")).toBeTrue();

    // 回调必须把 holder 归零再重排，否则 scheduleUserReplyTriggerSweep 第一行
    // 就返回，此后只剩逼近硬顶时那一次热路径补扫在收拾这张表。
    jest.advanceTimersByTime(500);
    expect(userReplyTriggerTimes.size).toBe(0);
    expect(userReplyTriggerSweepState.timer).toBeNull();
  });
});
