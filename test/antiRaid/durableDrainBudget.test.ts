/**
 * 停机排空在零预算下的收场。持久化那一步用的是真实的 flushDiskIO /
 * flushStateToDisk：两者对非正预算的拒绝方式不同（前者 async 拒绝、后者同步
 * 抛），把它们 mock 掉就再也看不见那条会逃逸的拒绝。
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";
import type { FlushResult } from "../../packages/types/lifecycle";

const { antiRaidBarrier, antiRaidRuntimeState } =
  await import("../../packages/cache/main/antiRaid/proxy");

/** 替身只做一件事：让 mailbox / drain 回执当场以 flushed 结算。 */
const { mock } = await import("bun:test");
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({
  postAntiRaid: (message: AntiRaidWorkerMessage): boolean => {
    if (message.type === "drain") antiRaidBarrier.settle(message.drainId, "flushed");
    if (message.type === "barrier") antiRaidBarrier.settle(message.barrierId, "flushed");
    return true;
  },
}));

const { drainAntiRaid } = await import("../../packages/antiRaid/durableDelivery");

const unhandled: unknown[] = [];
function recordUnhandled(reason: unknown): void { unhandled.push(reason); }

beforeEach((): void => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
  antiRaidRuntimeState.initialized = true;
});

afterEach((): void => {
  process.off("unhandledRejection", recordUnhandled);
  antiRaidRuntimeState.initialized = false;
});

afterAll((): void => { antiRaidRuntimeState.initialized = false; });

test("预算恰好耗尽时按 timedOut 收场，且不留下无人接管的拒绝", async () => {
  const result: FlushResult = await drainAntiRaid(0);

  expect(result).toBe("timedOut");
  // 两个 flush 各自的参数校验都会拒绝零预算；数组字面量在第二个同步抛出时中断，
  // 第一个已经产生的拒绝就没有 allSettled 接手了。
  await Bun.sleep(1);
  await Bun.sleep(1);
  expect(unhandled).toEqual([]);
});

test("未初始化时直接放行，不进入持久化步骤", async () => {
  antiRaidRuntimeState.initialized = false;

  expect(await drainAntiRaid(0)).toBe("flushed");
  await Bun.sleep(1);
  expect(unhandled).toEqual([]);
});
