import { describe, expect, test } from "bun:test";
import { RATE_LIMIT_LONG_MAX_TRIGGERS, REPLY_ROUND_MAX_CONCURRENT, REPLY_TRIGGER_QUEUE_MAX } from "../../src/consts/aiChat";
import { admitRound, admitTrigger } from "../../src/states/replyAdmission";
import type { TriggerKind } from "../../src/types/states/replyAdmission";

const ALL_KINDS: TriggerKind[] = ["direct", "random", "mediaDirect", "mediaRandom"];

describe("admitTrigger：并发未满", () => {
  for (const kind of ALL_KINDS) {
    test(`kind=${kind} 且 activeRounds 低于上限 → startRound，不看队列`, () => {
      const decision = admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT - 1, queueSize: REPLY_TRIGGER_QUEUE_MAX, kind });
      expect(decision).toEqual({ action: "startRound" });
    });
  }

  test("activeRounds 为 0 → startRound", () => {
    expect(admitTrigger({ activeRounds: 0, queueSize: 0, kind: "direct" })).toEqual({ action: "startRound" });
  });
});

describe("admitTrigger：并发已满（activeRounds === 上限，边界值）", () => {
  test("kind=random → dropSilently，即使队列全空", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: 0, kind: "random" })).toEqual({ action: "dropSilently" });
  });

  test("kind=mediaRandom → dropSilently，即使队列全空", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: 0, kind: "mediaRandom" })).toEqual({ action: "dropSilently" });
  });

  test("kind=direct 且队列未满 → enqueue", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: REPLY_TRIGGER_QUEUE_MAX - 1, kind: "direct" })).toEqual({
      action: "enqueue",
    });
  });

  test("kind=mediaDirect 且队列未满 → enqueue", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: 0, kind: "mediaDirect" })).toEqual({ action: "enqueue" });
  });

  test("kind=direct 且队列已达上限（边界值）→ enqueueOverflow", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: REPLY_TRIGGER_QUEUE_MAX, kind: "direct" })).toEqual({
      action: "enqueueOverflow",
    });
  });

  test("kind=mediaDirect 且队列已达上限 → enqueueOverflow", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: REPLY_TRIGGER_QUEUE_MAX, kind: "mediaDirect" })).toEqual({
      action: "enqueueOverflow",
    });
  });

  test("kind=direct 且队列超过上限（异常输入防御）→ enqueueOverflow", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT, queueSize: REPLY_TRIGGER_QUEUE_MAX + 5, kind: "direct" })).toEqual({
      action: "enqueueOverflow",
    });
  });
});

describe("admitTrigger：并发超过上限（异常输入防御，与 === 上限行为一致）", () => {
  test("kind=random → dropSilently", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT + 3, queueSize: 0, kind: "random" })).toEqual({ action: "dropSilently" });
  });

  test("kind=direct 且队列未满 → enqueue", () => {
    expect(admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT + 3, queueSize: 0, kind: "direct" })).toEqual({ action: "enqueue" });
  });
});

describe("admitRound：限频闸", () => {
  test("windowCount 低于上限 → run", () => {
    expect(admitRound({ windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS - 1 })).toEqual({ action: "run" });
  });

  test("windowCount 为 0 → run", () => {
    expect(admitRound({ windowCount: 0 })).toEqual({ action: "run" });
  });

  test("windowCount 达到上限（边界值）→ rateLimited", () => {
    expect(admitRound({ windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS })).toEqual({ action: "rateLimited" });
  });

  test("windowCount 超过上限 → rateLimited", () => {
    expect(admitRound({ windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS + 10 })).toEqual({ action: "rateLimited" });
  });
});

describe("补跑不占限频名额（组合场景，验证两道闸的分工）", () => {
  test("并发闸放行（补跑腾出空位）后，仍需过一次独立的限频闸判定", () => {
    // 补跑（drainReplyQueue）不会再调用 admitTrigger——它直接调
    // startReplyRound（对应真实解释器里 admitTrigger 被完全跳过），本用例
    // 验证的是 admitRound 本身与 activeRounds 无关：即便并发位已经腾出，
    // 限频闸只看滑动窗口计数，不因为“是补跑”而放宽或收紧。
    const admitted = admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT - 1, queueSize: 0, kind: "direct" });
    expect(admitted).toEqual({ action: "startRound" });
    expect(admitRound({ windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS })).toEqual({ action: "rateLimited" });
    expect(admitRound({ windowCount: RATE_LIMIT_LONG_MAX_TRIGGERS - 1 })).toEqual({ action: "run" });
  });
});
