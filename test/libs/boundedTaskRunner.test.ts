import { describe, expect, test } from "bun:test";
import { createBoundedTaskRunner } from "../../src/libs/boundedTaskRunner";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    expect(await Promise.all([p2, p3])).toEqual([2, 3]);
    expect(runner.activeCount).toBe(0);
  });
});
