/**
 * media 模态四档状态机（packages/states/mediaInputSupport.ts）的纯判定。
 * 不碰 holder、不记日志：落定 misconfigured 时只交出一条效果，由 AI Chat
 * Worker 的 owner 缓存去执行。
 */

import { describe, expect, test } from "bun:test";
import {
  INITIAL_MEDIA_INPUT_STATE,
  MEDIA_PROBE_BACKOFF_BASE_MS,
  MEDIA_PROBE_BACKOFF_MAX_MS,
  MEDIA_PROBE_MAX_TRANSIENT_FAILURES,
} from "../../packages/consts/aiChat/media";
import {
  isMediaInputClosed,
  isWithinMediaProbeBackoff,
  reduceMediaInputResult,
} from "../../packages/states/mediaInputSupport";
import type {
  AiTextResult,
} from "../../packages/types/aiChat/provider";
import type {
  MediaInputTransition,
  MediaInputModalityState,
} from "../../packages/types/states/mediaInputSupport";

const NOW: number = 1_000_000;

function state(overrides: Partial<MediaInputModalityState> = {}): MediaInputModalityState {
  return { ...INITIAL_MEDIA_INPUT_STATE, ...overrides };
}

interface ReduceOptions {
  readonly attemptState?: MediaInputModalityState;
  readonly now?: number;
}

function reduce(
  current: MediaInputModalityState,
  result: AiTextResult,
  { attemptState = current, now = NOW }: ReduceOptions = {}
): MediaInputTransition {
  return reduceMediaInputResult(current, { capability: "vision", result, attemptState, now });
}

const OK: AiTextResult = { ok: true, text: "描述" };
const TRANSIENT: AiTextResult = { ok: false, retryable: true, mediaFailure: "transient" };
const UNSUPPORTED: AiTextResult = { ok: false, retryable: false, mediaFailure: "unsupported" };
const MISCONFIGURED: AiTextResult = { ok: false, retryable: false, mediaFailure: "misconfigured" };
/** 单份媒体自己的问题：不带 mediaFailure。 */
const MEDIA_ONLY: AiTextResult = { ok: false, retryable: true };

describe("配置代次", () => {
  test("旧配置代次的结论一律不改写当前状态", () => {
    const current: MediaInputModalityState = state({ configGeneration: 2 });

    for (const result of [OK, TRANSIENT, UNSUPPORTED, MISCONFIGURED]) {
      const transition: MediaInputTransition = reduce(current, result, { attemptState: state({ configGeneration: 1 }) });
      expect(transition.next).toBe(current);
      expect(transition.effects).toEqual([]);
    }
  });
});

describe("终局结论", () => {
  test("unsupported 落定后不再变化，也不记诊断", () => {
    const first: MediaInputTransition = reduce(state(), UNSUPPORTED);
    expect(first.next.support).toBe("unsupported");
    expect(first.effects).toEqual([]);

    // 重复同一结论时状态原样返回，调用方据此跳过整表替换。
    expect(reduce(first.next, UNSUPPORTED).next).toBe(first.next);
  });

  test("misconfigured 只在落定那一次交出诊断效果", () => {
    const first: MediaInputTransition = reduce(state(), MISCONFIGURED);

    expect(first.next.support).toBe("misconfigured");
    expect(first.effects).toEqual([
      { kind: "logMisconfiguredMediaEndpoint", capability: "vision" },
    ]);
    expect(reduce(first.next, MISCONFIGURED).effects).toEqual([]);
  });

  test("落定之后瞬时故障不得翻案", () => {
    for (const support of ["unsupported", "misconfigured"] as const) {
      const current: MediaInputModalityState = state({ support });
      expect(isMediaInputClosed(support)).toBeTrue();
      expect(reduce(current, TRANSIENT).next).toBe(current);
    }
  });
});

describe("瞬时故障退避", () => {
  test("结论不动，只推进退避；连续失败按指数增长并封顶", () => {
    let current: MediaInputModalityState = state();
    let now: number = NOW;
    const backoffs: number[] = [];
    for (let round: number = 0; round < MEDIA_PROBE_MAX_TRANSIENT_FAILURES + 2; round++) {
      const transition: MediaInputTransition = reduce(current, TRANSIENT, { now });
      expect(transition.next.support).toBe("unknown");
      backoffs.push(transition.next.nextProbeAt - now);
      current = transition.next;
      now = current.nextProbeAt;
    }

    expect(backoffs[0]).toBe(MEDIA_PROBE_BACKOFF_BASE_MS);
    expect(backoffs[1]).toBe(MEDIA_PROBE_BACKOFF_BASE_MS * 2);
    expect(backoffs.at(-1)).toBe(MEDIA_PROBE_BACKOFF_MAX_MS);
    expect(current.transientFailures).toBe(MEDIA_PROBE_MAX_TRANSIENT_FAILURES);
  });

  test("退避窗口内的失败不再累加计数", () => {
    const current: MediaInputModalityState = state({
      transientFailures: 1,
      nextProbeAt: NOW + MEDIA_PROBE_BACKOFF_BASE_MS,
    });

    expect(isWithinMediaProbeBackoff(current.nextProbeAt, NOW)).toBeTrue();
    expect(reduce(current, TRANSIENT).next).toBe(current);
  });

  test("同代次其它请求的迟到失败不再计数", () => {
    const current: MediaInputModalityState = state({ transientFailures: 1 });
    const staleAttempt: MediaInputModalityState = state({ transientFailures: 0 });

    expect(reduce(current, TRANSIENT, { attemptState: staleAttempt }).next).toBe(current);
  });

  test("墙钟回拨把 nextProbeAt 推到过远的未来时直接放行", () => {
    const farFuture: number = NOW + MEDIA_PROBE_BACKOFF_MAX_MS + 1;

    expect(isWithinMediaProbeBackoff(farFuture, NOW)).toBeFalse();
    expect(reduce(state({ nextProbeAt: farFuture }), TRANSIENT).next.transientFailures).toBe(1);
  });

  test("supported 下的瞬时故障只推进退避，不退回 unknown", () => {
    const current: MediaInputModalityState = state({ support: "supported" });

    expect(reduce(current, TRANSIENT).next.support).toBe("supported");
  });
});

describe("成功与单份媒体故障", () => {
  test("成功清空失败计数与退避", () => {
    const current: MediaInputModalityState = state({
      support: "unknown",
      transientFailures: 3,
      nextProbeAt: NOW + 10,
    });

    expect(reduce(current, OK).next).toEqual({
      support: "supported",
      transientFailures: 0,
      nextProbeAt: 0,
      configGeneration: 0,
    });
  });

  test("已经是干净的 supported 时不整表替换", () => {
    const current: MediaInputModalityState = state({ support: "supported" });

    expect(reduce(current, OK).next).toBe(current);
  });

  test("不带 mediaFailure 的失败完全不改变模态状态", () => {
    for (const support of ["unknown", "supported"] as const) {
      const current: MediaInputModalityState = state({ support });
      expect(reduce(current, MEDIA_ONLY).next).toBe(current);
    }
  });
});
