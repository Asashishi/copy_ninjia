import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { wedChats, wedRuntime } from "../../packages/cache/main/wed";
import { WED_MAX_CONCURRENT, WED_MAX_PENDING } from "../../packages/consts/wed";
import { getOrCreateWedChat } from "../../packages/commands/wed/chats";
import { drainWedRuntime, initWedRuntime, quiesceWedRuntime, submitWedTask } from "../../packages/commands/wed/runtime";
import { currentUpdateAbortSignal, runWithUpdateAbortSignal } from "../../packages/infra/updateContext";
import type { WedChat } from "../../packages/types/wed";

const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];

function heldTask(): ReturnType<typeof Promise.withResolvers<void>> {
  const gate = Promise.withResolvers<void>();
  gates.push(gate);
  return gate;
}

beforeEach(initWedRuntime);
afterEach(async () => {
  await drainWedRuntime(0);
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(wedRuntime.current!.tasks);
  gates.length = 0;
  wedChats.clear();
});

test("达到配置的并发上限后按 FIFO 补位；等待出站时不释放槽位", async () => {
  const chat = getOrCreateWedChat(-1001)!;
  const starts: number[] = [];
  const finished = Array.from({ length: WED_MAX_CONCURRENT + 2 }, heldTask);
  const started = Array.from({ length: WED_MAX_CONCURRENT + 2 }, () => Promise.withResolvers<void>());
  for (let id = 0; id < WED_MAX_CONCURRENT + 2; id++) {
    expect(submitWedTask(chat, async () => {
      starts.push(id);
      started[id]!.resolve();
      await finished[id]!.promise;
    })).toBeTrue();
  }
  await Promise.allSettled(started.slice(0, WED_MAX_CONCURRENT).map((item) => item.promise));
  expect(starts).toEqual(Array.from({ length: WED_MAX_CONCURRENT }, (_, id) => id));
  expect(wedRuntime.current!.runner.activeCount).toBe(WED_MAX_CONCURRENT);
  expect(wedRuntime.current!.runner.pendingCount).toBe(2);
  finished[0]!.resolve();
  await started[WED_MAX_CONCURRENT]!.promise;
  expect(starts.at(-1)).toBe(WED_MAX_CONCURRENT);
  expect(starts).toHaveLength(WED_MAX_CONCURRENT + 1);
  expect(wedRuntime.current!.runner.activeCount).toBe(WED_MAX_CONCURRENT);
  finished[1]!.resolve();
  await started[WED_MAX_CONCURRENT + 1]!.promise;
  expect(starts.at(-1)).toBe(WED_MAX_CONCURRENT + 1);
});

test("队列有硬上限，满额拒绝不启动新任务；紧急停机撤销所有未开始任务", async () => {
  const chat = getOrCreateWedChat(-1001)!;
  const held = heldTask();
  const execute = mock(() => held.promise);
  for (let id = 0; id < WED_MAX_CONCURRENT + WED_MAX_PENDING; id++) {
    expect(submitWedTask(chat, execute)).toBeTrue();
  }
  const overflow = mock(async () => {});
  expect(submitWedTask(chat, overflow)).toBeFalse();
  await Bun.sleep(0);
  expect(execute).toHaveBeenCalledTimes(WED_MAX_CONCURRENT);
  expect(wedRuntime.current!.runner.pendingCount).toBe(WED_MAX_PENDING);
  expect(await drainWedRuntime(0)).toBe("timedOut");
  expect(wedRuntime.current!.runner.pendingCount).toBe(0);
  expect(submitWedTask(chat, execute)).toBeFalse();
  held.resolve();
  await Promise.allSettled(wedRuntime.current!.tasks);
  expect(execute).toHaveBeenCalledTimes(WED_MAX_CONCURRENT);
  expect(overflow).not.toHaveBeenCalled();
  expect(await drainWedRuntime(0)).toBe("flushed");
});

test("群关闭只撤销该群等待项，另一个群继续补位，重新启用不能复活旧任务", async () => {
  const first: WedChat = getOrCreateWedChat(-1001)!;
  const other: WedChat = getOrCreateWedChat(-1002)!;
  const held = heldTask();
  for (let id = 0; id < WED_MAX_CONCURRENT; id++) submitWedTask(other, () => held.promise);
  const expired = mock(async () => {});
  const started = Promise.withResolvers<void>();
  submitWedTask(first, expired);
  submitWedTask(other, async () => { started.resolve(); });
  wedChats.delete(-1001);
  first.controller.abort();
  const renewed = getOrCreateWedChat(-1001)!;
  expect(renewed).not.toBe(first);
  expect(submitWedTask(first, expired)).toBeFalse();
  expect(wedRuntime.current!.runner.pendingCount).toBe(1);
  held.resolve();
  await started.promise;
  expect(expired).not.toHaveBeenCalled();
});

test("出队恢复自己的取消上下文，不继承释放槽位任务的 update 信号", async () => {
  const chat = getOrCreateWedChat(-1001)!;
  const earlier = new AbortController();
  const later = new AbortController();
  const held = heldTask();
  await runWithUpdateAbortSignal(earlier.signal, async () => {
    for (let id = 0; id < WED_MAX_CONCURRENT; id++) submitWedTask(chat, () => held.promise);
  });
  const started = Promise.withResolvers<AbortSignal>();
  const finish = heldTask();
  await runWithUpdateAbortSignal(later.signal, async () => {
    submitWedTask(chat, async () => {
      started.resolve(currentUpdateAbortSignal()!);
      await finish.promise;
    });
  });
  earlier.abort();
  held.resolve();
  const signal = await started.promise;
  expect(signal.aborted).toBeFalse();
  later.abort();
  expect(signal.aborted).toBeTrue();
});

test("普通停机关闭接纳但排空已接纳任务，预算耗尽取消正在使用的信号", async () => {
  const chat = getOrCreateWedChat(-1001)!;
  const held = heldTask();
  const started = Promise.withResolvers<AbortSignal>();
  submitWedTask(chat, async () => {
    started.resolve(currentUpdateAbortSignal()!);
    await held.promise;
  });
  const signal = await started.promise;
  quiesceWedRuntime();
  expect(submitWedTask(chat, async () => {})).toBeFalse();
  expect(signal.aborted).toBeFalse();
  expect(() => initWedRuntime()).toThrow("unsettled");
  expect(await drainWedRuntime(5)).toBe("timedOut");
  expect(signal.aborted).toBeTrue();
  held.resolve();
  await Promise.allSettled(wedRuntime.current!.tasks);
  expect(await drainWedRuntime(0)).toBe("flushed");
  initWedRuntime();
  expect(wedRuntime.current!.accepting).toBeTrue();
});

test("任务失败仍释放并发槽并继续排空，空闲和非法停机预算分别处理", async () => {
  const chat = getOrCreateWedChat(-1001)!;
  submitWedTask(chat, async () => { throw new Error("expected wed task failure"); });
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(wedRuntime.current!.runner.activeCount).toBe(0);
  expect(wedRuntime.current!.tasks.size).toBe(0);
  await expect(drainWedRuntime(-1)).rejects.toThrow("finite and non-negative");
});
