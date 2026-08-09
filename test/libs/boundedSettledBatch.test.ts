import { describe, expect, test } from "bun:test";
import {
  runBoundedSettledBatch,
} from "../../packages/libs/boundedSettledBatch";
import type {
  BoundedBatchFailure,
  BoundedBatchResult,
} from "../../packages/libs/boundedSettledBatch";

describe("runBoundedSettledBatch", () => {
  test("固定 worker 数限制并发并按原输入顺序返回逐项结果", async () => {
    let active: number = 0;
    let peak: number = 0;
    const results: BoundedBatchResult<number, number>[] =
      await runBoundedSettledBatch<number, number>({
        items: [0, 1, 2, 3, 4, 5],
        maxConcurrent: 2,
        execute: async ({ item }): Promise<number> => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(item % 2 === 0 ? 2 : 1);
          active--;
          return item * 10;
        },
      });

    expect(peak).toBe(2);
    expect(results.map((result) => result.item)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results.map((result) =>
      result.status === "fulfilled" ? result.value : undefined
    )).toEqual([0, 10, 20, 30, 40, 50]);
  });

  test("只按有限退避预算重试可重试项，并记录 item、index、attempt 与 delay", async () => {
    const attempts = new Map<string, number>();
    const traces: string[] = [];
    const results: BoundedBatchResult<string, string>[] =
      await runBoundedSettledBatch<string, string>({
        items: ["transient", "permanent"],
        maxConcurrent: 1,
        retryDelaysMs: [1, 1],
        shouldRetry: ({ item }: BoundedBatchFailure<string>): boolean => item === "transient",
        onRetry: ({ item, index, attempt, delayMs }): void => {
          traces.push(`${item}:${index}:${attempt}:${delayMs}`);
        },
        execute: async ({ item }): Promise<string> => {
          const attempt: number = (attempts.get(item) ?? 0) + 1;
          attempts.set(item, attempt);
          if (item === "permanent" || attempt < 3) throw new Error(`${item}-${attempt}`);
          return "recovered";
        },
      });

    expect(traces).toEqual(["transient:0:1:1", "transient:0:2:1"]);
    expect(results[0]).toMatchObject({
      item: "transient",
      index: 0,
      attempt: 3,
      status: "fulfilled",
      value: "recovered",
    });
    expect(results[1]).toMatchObject({
      item: "permanent",
      index: 1,
      attempt: 1,
      status: "rejected",
    });
  });

  test("拒绝非法并发和退避参数", async () => {
    await expect(runBoundedSettledBatch({
      items: [1],
      maxConcurrent: 0,
      execute: async (): Promise<number> => 1,
    })).rejects.toThrow("maxConcurrent");
    await expect(runBoundedSettledBatch({
      items: [1],
      maxConcurrent: 1,
      retryDelaysMs: [0],
      execute: async (): Promise<number> => 1,
    })).rejects.toThrow("retry delays");
  });
});
