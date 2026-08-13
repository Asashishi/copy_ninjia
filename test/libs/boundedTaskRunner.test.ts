import { describe, expect, test } from "bun:test";
import { createBoundedTaskRunner } from "../../packages/libs/boundedTaskRunner";
import { deferred } from "./helpers";

describe("createBoundedTaskRunner", () => {
  test("限制执行与等待数量，饱和后立即拒绝且槽位释放后继续队列", async () => {
    const runner = createBoundedTaskRunner(2, 1);
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const started: number[] = [];

    const run = (id: number, gate: Promise<void>) => runner.run(async () => {
      started.push(id);
      await gate;
      return id;
    });

    const p1 = run(1, first.promise);
    const p2 = run(2, second.promise);
    const p3 = run(3, third.promise);
    const rejected = runner.run(async () => 4);
    await Promise.resolve();

    expect(runner.activeCount).toBe(2);
    expect(runner.pendingCount).toBe(1);
    expect(started).toEqual([1, 2]);
    expect(await rejected).toBeUndefined();

    first.resolve();
    expect(await p1).toBe(1);
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    expect(runner.activeCount).toBe(2);
    expect(runner.pendingCount).toBe(0);

    second.resolve();
    third.resolve();
    const results = await Promise.allSettled([p2, p3]);
    expect(results).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 3 },
    ]);
    expect(runner.activeCount).toBe(0);
  });

  test("取消等待中的任务会立即释放队列位置且不执行任务", async () => {
    const runner = createBoundedTaskRunner(1, 1);
    const gate = deferred();
    const controller: AbortController = new AbortController();
    let queuedStarted: boolean = false;
    const active: Promise<void | undefined> = runner.run(async (): Promise<void> => {
      await gate.promise;
    });
    const queued: Promise<void | undefined> = runner.run(
      async (): Promise<void> => {
        queuedStarted = true;
      },
      controller.signal
    );

    await Promise.resolve();
    expect(runner.pendingCount).toBe(1);
    controller.abort();
    expect(await queued).toBeUndefined();
    expect(runner.pendingCount).toBe(0);

    gate.resolve();
    await active;
    expect(queuedStarted).toBeFalse();
  });

  test("占到执行位后、真正调用前被取消的任务不再执行", async () => {
    // start() 先占执行位，任务本体要到下一个微任务才调用；这一拍里取消的话，
    // 排队路径上的那套摘除逻辑根本不参与，只有 start() 里的复查挡得住。
    const runner = createBoundedTaskRunner(1, 0);
    const controller: AbortController = new AbortController();
    let started: boolean = false;
    const task: Promise<void | undefined> = runner.run(
      async (): Promise<void> => {
        started = true;
      },
      controller.signal
    );

    expect(runner.activeCount).toBe(1);
    controller.abort();
    expect(await task).toBeUndefined();
    expect(started).toBeFalse();
    expect(runner.activeCount).toBe(0);
  });
});
