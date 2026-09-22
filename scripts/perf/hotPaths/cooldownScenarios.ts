import { clearUserReplyTriggerTimes, tryClaimUserReplyTrigger } from "../../../packages/auto/message/triggerPolicy";
import { USER_REPLY_TRIGGER_CACHE_MAX, USER_REPLY_TRIGGER_COOLDOWN_MS } from "../../../packages/consts/auto";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS } from "./fixtures";
import type { Scenario } from "./types";

type CooldownMode = "hit" | "renew" | "growth" | "saturated" | "expiry";

/** 固定生产容量与冷却窗口，分别测量命中、续期、建表、满载拒绝和整批到期。 */
export function cooldownScenario(mode: CooldownMode): Scenario {
  let now: number = BENCHMARK_EPOCH_MS;
  let offset: number = 0;
  return {
    iterations: mode === "growth" ? USER_REPLY_TRIGGER_CACHE_MAX : 100_000,
    warmupIterations: mode === "growth" ? USER_REPLY_TRIGGER_CACHE_MAX : undefined,
    resetBeforeSample: mode === "growth",
    reset: (): void => {
      clearUserReplyTriggerTimes();
      now = BENCHMARK_EPOCH_MS;
      offset = 0;
    },
    prepare: (): void => {
      const size: number = mode === "growth" ? 0 : mode === "renew" ? 1 : USER_REPLY_TRIGGER_CACHE_MAX;
      for (let userId: number = 1; userId <= size; userId++) {
        if (!tryClaimUserReplyTrigger(BENCHMARK_CHAT_ID, userId, now)) throw new Error("Cooldown fixture seed failed.");
      }
    },
    run: (iterations: number): number => {
      let claimed: number = 0;
      for (let index: number = 0; index < iterations; index++) {
        if (mode === "expiry" && index % USER_REPLY_TRIGGER_CACHE_MAX === 0) {
          now += USER_REPLY_TRIGGER_COOLDOWN_MS;
          offset = offset === 0 ? USER_REPLY_TRIGGER_CACHE_MAX : 0;
        } else if (mode === "renew") {
          now += USER_REPLY_TRIGGER_COOLDOWN_MS;
        }
        const userId: number = mode === "saturated" ? USER_REPLY_TRIGGER_CACHE_MAX + 1 + (index & 255)
          : mode === "renew" ? 1
          : mode === "growth" ? index + 1
          : mode === "expiry" ? offset + 1 + index % USER_REPLY_TRIGGER_CACHE_MAX
          : 1 + (index & 255);
        if (tryClaimUserReplyTrigger(BENCHMARK_CHAT_ID, userId, now)) claimed++;
      }
      const expected: number = mode === "hit" || mode === "saturated" ? 0 : iterations;
      if (claimed !== expected) throw new Error(`Cooldown ${mode} decisions differ from fixture expectations.`);
      return claimed;
    },
    probes: { tryClaimUserReplyTrigger },
  };
}
