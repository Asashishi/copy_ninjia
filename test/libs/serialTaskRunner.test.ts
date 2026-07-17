import { describe, expect, mock, test } from "bun:test";
import { createSerialTaskRunner } from "../../src/libs/serialTaskRunner";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createSerialTaskRunner", () => {
  test("严格按提交顺序执行，较早的慢任务不会晚于新任务落地", async () => {
    const first = deferred();
    const second = deferred();
    const started: number[] = [];
    const finished: number[] = [];
    const onError = mock((..._args: unknown[]): void => {});
    const runner = createSerialTaskRunner(onError);

    runner.run(async () => {
      started.push(1);
      await first.promise;
      finished.push(1);
    });
    runner.run(async () => {
      started.push(2);
      await second.promise;
      finished.push(2);
    });
    await Promise.resolve();

    expect(started).toEqual([1]);
    first.resolve();
    await Bun.sleep(0);
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1]);

    second.resolve();
    await Bun.sleep(0);
    expect(finished).toEqual([1, 2]);
    expect(onError).not.toHaveBeenCalled();
  });

  test("任务失败被报告后继续执行下一项", async () => {
    const error = new Error("avatar failed");
    const onError = mock((..._args: unknown[]): void => {});
    const runner = createSerialTaskRunner(onError);
    const completed: number[] = [];

    runner.run(async () => {
      throw error;
    });
    runner.run(async () => {
      completed.push(2);
    });
    await Bun.sleep(0);

    expect(onError).toHaveBeenCalledWith(error);
    expect(completed).toEqual([2]);
  });
});
