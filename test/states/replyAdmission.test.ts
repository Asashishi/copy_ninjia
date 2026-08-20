import { describe, expect, test } from "bun:test";
import {
  RATE_LIMIT_LONG_MAX_TRIGGERS,
  REPLY_ROUND_MAX_CONCURRENT,
  REPLY_TRIGGER_QUEUE_MAX,
} from "../../packages/consts/aiChat/rateLimit";
import { admitRound, admitTrigger as decideTrigger } from "../../packages/states/replyAdmission";
import type { AdmitDecision, AdmitTriggerInput, TriggerKind } from "../../packages/types/states/replyAdmission";

const ALL_KINDS: TriggerKind[] = ["direct", "random", "mediaDirect", "mediaRandom"];

function admitTrigger(
  input: Omit<AdmitTriggerInput, "telegramBackpressured">
): AdmitDecision {
  return decideTrigger({ ...input, telegramBackpressured: false });
}

describe("admitTrigger：并发未满且队列已空", () => {
  for (const kind of ALL_KINDS) {
    test(`kind=${kind} 且 activeRounds 低于上限 → startRound`, () => {
      const decision = admitTrigger({ activeRounds: REPLY_ROUND_MAX_CONCURRENT - 1, queueSize: 0, kind });
      expect(decision).toEqual({ action: "startRound" });
    });
  }

  test("activeRounds 为 0 → startRound", () => {
    expect(admitTrigger({ activeRounds: 0, queueSize: 0, kind: "direct" })).toEqual({ action: "startRound" });
  });
});

describe("admitTrigger：并发未满但队列非空", () => {
  // 队列非空只可能是限频闸拦下过补跑。让新触发抢在队里那些人前面，就把队列的
  // FIFO 语义整个反过来了——窗口一放开，先跑的会是刚到的这条，而队里的人已经
  // 等了几分钟。空并发位由补跑消费。
  test("kind=direct → enqueue，不插队", () => {
    expect(admitTrigger({ activeRounds: 0, queueSize: 1, kind: "direct" })).toEqual({ action: "enqueue" });
  });

  test("kind=random → dropSilently：随机触发本就不排队", () => {
    expect(admitTrigger({ activeRounds: 0, queueSize: 1, kind: "random" })).toEqual({ action: "dropSilently" });
  });

  test("队列已满 → enqueueOverflow", () => {
    expect(admitTrigger({ activeRounds: 0, queueSize: REPLY_TRIGGER_QUEUE_MAX, kind: "direct" }))
      .toEqual({ action: "enqueueOverflow" });
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

describe("admitTrigger：Telegram 发送面软背压", () => {
  test("随机触发即使没有在途轮次也静默丢弃", () => {
    expect(decideTrigger({
      activeRounds: 0,
      queueSize: 0,
      kind: "random",
      telegramBackpressured: true,
    })).toEqual({ action: "dropSilently" });
  });

  test("直接触发最多保留一个同群在途轮次", () => {
    expect(decideTrigger({
      activeRounds: 1,
      queueSize: 0,
      kind: "direct",
      telegramBackpressured: true,
    })).toEqual({ action: "enqueue" });
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
