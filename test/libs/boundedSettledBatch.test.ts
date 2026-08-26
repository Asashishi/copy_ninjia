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

  /**
   * 下面四条钉住的是本模块的**防御分支**：回调自身抛出、worker 意外 reject、
   * 以及「逐项结果没填满」这个不变量违背。这套批处理骨架承载黑名单补扫、
   * 批量踢人等不可逆动作——回调抛错时
   * 若把整批吞掉或让某一项静默消失，调用方拿到的是一份「都成功了」的假战报。
   */
  test("shouldRetry 自身抛出时按该项失败结算，并把原错与分类器错一并交出", async () => {
    const classifierError: Error = new Error("classifier exploded");
    const results: BoundedBatchResult<number, number>[] =
      await runBoundedSettledBatch<number, number>({
        items: [1, 2],
        maxConcurrent: 1,
        retryDelaysMs: [1],
        execute: async ({ item }): Promise<number> => {
          if (item === 1) throw new Error("execute failed");
          return item;
        },
        shouldRetry: (): boolean => { throw classifierError; },
      });

    const first: BoundedBatchResult<number, number> = results[0]!;
    expect(first.status).toBe("rejected");
    const reason: unknown = first.status === "rejected" ? first.reason : undefined;
    expect(reason).toBeInstanceOf(AggregateError);
    expect((reason as AggregateError).errors).toHaveLength(2);
    expect((reason as AggregateError).errors[1]).toBe(classifierError);
    // 同批的其它项不受牵连，照常结算。
    expect(results[1]?.status).toBe("fulfilled");
  });

  test("onRetry 自身抛出时同样只失败该项，不改变其它项的重试语义", async () => {
    const traceError: Error = new Error("trace sink exploded");
    let attempts: number = 0;
    const results: BoundedBatchResult<number, number>[] =
      await runBoundedSettledBatch<number, number>({
        items: [1, 2],
        maxConcurrent: 1,
        retryDelaysMs: [1],
        execute: async ({ item }): Promise<number> => {
          if (item === 1) { attempts++; throw new Error("execute failed"); }
          return item;
        },
        onRetry: (): void => { throw traceError; },
      });

    const first: BoundedBatchResult<number, number> = results[0]!;
    expect(first.status).toBe("rejected");
    const reason: unknown = first.status === "rejected" ? first.reason : undefined;
    expect(reason).toBeInstanceOf(AggregateError);
    expect((reason as AggregateError).errors[1]).toBe(traceError);
    // 钩子抛出发生在退避之前，因此那次重试没有真的发生。
    expect(attempts).toBe(1);
    expect(results[1]?.status).toBe("fulfilled");
  });

  test("execute 同步抛出（不返回 Promise）也按该项失败结算，不炸穿整批", async () => {
    const results: BoundedBatchResult<number, number>[] =
      await runBoundedSettledBatch<number, number>({
        items: [1, 2],
        maxConcurrent: 2,
        execute: ((): Promise<number> => { throw new Error("sync throw"); }),
      });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBeTrue();
  });

  test("空输入直接返回空数组，不启动任何 worker", async () => {
    let executed: number = 0;
    const results: BoundedBatchResult<number, number>[] =
      await runBoundedSettledBatch<number, number>({
        items: [],
        maxConcurrent: 4,
        execute: async (): Promise<number> => { executed++; return 0; },
      });
    expect(results).toEqual([]);
    expect(executed).toBe(0);
  });
});
