import { describe, expect, test } from "bun:test";
import { createLatestValueRunner } from "../../src/libs/latestValueRunner";

describe("createLatestValueRunner", () => {
  test("写入在途时只保留最新待处理值", async () => {
    const consumed: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = createLatestValueRunner<number>(async (value) => {
      consumed.push(value);
      if (value === 1) await firstBlocked;
    });

    const first = runner.push(1);
    const second = runner.push(2);
    const third = runner.push(3);
    expect(consumed).toEqual([1]);

    releaseFirst!();
    await Promise.all([first, second, third]);
    expect(consumed).toEqual([1, 3]);
  });

  test("空闲后可以启动下一轮", async () => {
    const consumed: string[] = [];
    const runner = createLatestValueRunner<string>(async (value) => {
      consumed.push(value);
    });

    await runner.push("a");
    await runner.push("b");
    expect(consumed).toEqual(["a", "b"]);
  });

  test("支持 undefined 作为合法值", async () => {
    const consumed: (string | undefined)[] = [];
    const runner = createLatestValueRunner<string | undefined>(async (value) => {
      consumed.push(value);
    });

    await runner.push(undefined);
    expect(consumed).toEqual([undefined]);
  });

  test("一次消费失败也会继续处理期间到达的最新值", async () => {
    const consumed: number[] = [];
    const runner = createLatestValueRunner<number>(async (value) => {
      consumed.push(value);
      if (value === 1) throw new Error("first write failed");
    });

    const first = runner.push(1);
    const second = runner.push(2);
    await expect(first).rejects.toThrow("first write failed");
    await expect(second).rejects.toThrow("first write failed");
    expect(consumed).toEqual([1, 2]);
  });

  test("排空完成与 promise 结算之间到达的新值不会被搁置", async () => {
    const consumed: number[] = [];
    const runner = createLatestValueRunner<number>(async (value) => {
      consumed.push(value);
    });

    const first = runner.push(1);
    let second: Promise<void> | undefined;
    queueMicrotask(() => {
      second = runner.push(2);
    });
    await first;
    await Promise.resolve();
    await second;
    expect(consumed).toEqual([1, 2]);
  });
});
