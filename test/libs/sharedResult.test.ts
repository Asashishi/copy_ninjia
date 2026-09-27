import { expect, test } from "bun:test";
import type { SharedResult } from "../../packages/libs/sharedResult";
import { createSharedResult } from "../../packages/libs/sharedResult";

test("共享源只登记一次结算，取消的消费者立即摘除且不影响存活消费者", async (): Promise<void> => {
  const source: PromiseWithResolvers<string | null> = Promise.withResolvers<string | null>();
  let unused: number = 0;
  const shared: SharedResult<string | null> = createSharedResult(source.promise, {
    cancelled: null, rejected: null, onUnused: (): void => { unused++; },
  });
  const survivor: AbortController = new AbortController();
  const surviving: Promise<string | null> = shared.wait(survivor.signal);
  for (let index: number = 0; index < 1_000; index++) {
    const controller: AbortController = new AbortController();
    const cancelled: Promise<string | null> = shared.wait(controller.signal);
    controller.abort();
    expect(shared.waiterCount).toBe(1);
    expect(await cancelled).toBeNull();
  }
  expect(unused).toBe(0);
  source.resolve("done");
  expect(await surviving).toBe("done");
  expect(shared.waiterCount).toBe(0);
  expect(await shared.wait(survivor.signal)).toBe("done");
  survivor.abort();
  expect(await shared.wait(survivor.signal)).toBeNull();
  expect(unused).toBe(0);
});

test("最后一个消费者取消才通知 owner；重复使用相同 signal 的订阅独立结算", async (): Promise<void> => {
  const source: PromiseWithResolvers<string | null> = Promise.withResolvers<string | null>();
  let unused: number = 0;
  const shared: SharedResult<string | null> = createSharedResult(source.promise, {
    cancelled: null, rejected: null, onUnused: (): void => { unused++; },
  });
  const controller: AbortController = new AbortController();
  const first: Promise<string | null> = shared.wait(controller.signal);
  const second: Promise<string | null> = shared.wait(controller.signal);
  expect(shared.waiterCount).toBe(2);
  controller.abort();
  expect(shared.waiterCount).toBe(0);
  expect(unused).toBe(1);
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  source.resolve("late");
  expect(await shared.promise).toBe("late");
});

test("无信号消费者固定持有任务；源拒绝统一返回回退结果", async (): Promise<void> => {
  const source: PromiseWithResolvers<string | null> = Promise.withResolvers<string | null>();
  let unused: number = 0;
  const shared: SharedResult<string | null> = createSharedResult(source.promise, {
    cancelled: null, rejected: "failed", onUnused: (): void => { unused++; },
  });
  const pinned: Promise<string | null> = shared.wait();
  expect(shared.wait()).toBe(pinned);
  const controller: AbortController = new AbortController();
  const cancelled: Promise<string | null> = shared.wait(controller.signal);
  const survivor: Promise<string | null> = shared.wait(new AbortController().signal);
  controller.abort();
  expect(await cancelled).toBeNull();
  expect(unused).toBe(0);
  source.reject(new Error("test rejection"));
  expect(await pinned).toBe("failed");
  expect(await survivor).toBe("failed");
  expect(shared.waiterCount).toBe(0);
});
