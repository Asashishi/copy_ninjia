/**
 * 防刷屏成员窗口的三条场景：单成员命中、建表增长、满载稳定淘汰。
 *
 * 与 scenarios.ts 分开：三条共用同一套 observeMemberMessage/resetFloodWindows
 * 与全局硬顶常量，改防刷屏记账时只需读这一个文件。
 */

import { FLOOD_WINDOW_MAX_MEMBERS } from "../../../packages/consts/antiRaid/flood";
import {
  observeMemberMessage,
  resetFloodWindows,
} from "../../../packages/workers/antiRaid/floodControl";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS } from "./fixtures";
import type { Scenario } from "./types";

/**
 * 防刷屏开启后每条候选群消息都会走的单成员窗口命中路径。
 *
 * 只量同步记账叶子，不调用会派生 Telegram 请求的 handleFloodCandidate；每达到
 * 阈值时 observeMemberMessage 自己清空时间队列，下一轮仍保持同一个既有成员。
 * now 在所有预热和正式样本间单调递增，既贴近生产 Date.now() 的量级，也避免
 * 样本边界的人为时钟回拨改变被测分支。
 */
export function floodWindowHitScenario(): Scenario {
  let nextNow: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: 1_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const userId: number = 42 + (index & 1);
        if (observeMemberMessage(BENCHMARK_CHAT_ID, userId, nextNow) !== undefined) {
          checksum += 1;
        }
        nextNow += 1;
      }
      return checksum;
    },
    reset: (): void => {
      resetFloodWindows();
      nextNow = BENCHMARK_EPOCH_MS;
    },
    probes: { observeMemberMessage },
  };
}

/**
 * 刷屏窗口从空表增长到全局硬顶的相变路径。
 *
 * 每个正式样本计时前都清空，确保读数不混入满载淘汰；与下方 steady 场景分开
 * 判断建表分配期和稳定 LRU 淘汰期的 JIT/GC 行为。
 */
export function floodWindowGrowthScenario(): Scenario {
  let nextUserId: number = 1;
  let nextNow: number = BENCHMARK_EPOCH_MS;
  return {
    iterations: FLOOD_WINDOW_MAX_MEMBERS,
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        observeMemberMessage(BENCHMARK_CHAT_ID, nextUserId, nextNow);
        nextUserId += 1;
        nextNow += 1;
      }
      return nextUserId;
    },
    reset: (): void => {
      resetFloodWindows();
      nextUserId = 1;
      nextNow = BENCHMARK_EPOCH_MS;
    },
    resetBeforeSample: true,
    probes: { observeMemberMessage },
  };
}

/** 满载后只执行稳定 LRU 淘汰；预填充不进入预热或正式样本计时。 */
export function floodWindowSteadyScenario(): Scenario {
  let nextUserId: number = FLOOD_WINDOW_MAX_MEMBERS + 1;
  let nextNow: number = BENCHMARK_EPOCH_MS + FLOOD_WINDOW_MAX_MEMBERS;
  return {
    iterations: 200_000,
    prepare: (): void => {
      for (
        let userId: number = 1;
        userId <= FLOOD_WINDOW_MAX_MEMBERS;
        userId++
      ) {
        observeMemberMessage(BENCHMARK_CHAT_ID, userId, nextNow);
        nextNow += 1;
      }
      nextUserId = FLOOD_WINDOW_MAX_MEMBERS + 1;
    },
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index += 1) {
        observeMemberMessage(BENCHMARK_CHAT_ID, nextUserId, nextNow);
        nextUserId += 1;
        nextNow += 1;
      }
      return nextUserId;
    },
    reset: (): void => {
      resetFloodWindows();
      nextUserId = FLOOD_WINDOW_MAX_MEMBERS + 1;
      nextNow = BENCHMARK_EPOCH_MS;
    },
    probes: { observeMemberMessage },
  };
}
