import { describe, expect, test } from "bun:test";
import {
  runBoundedSettledBatch,
} from "../../packages/libs/boundedSettledBatch";
import type { BoundedBatchResult } from "../../packages/libs/boundedSettledBatch";

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

  test("失败项只执行一次并按该项结算，保留 item 与 index，其它项照常完成", async () => {
    const executions: Map<string, number> = new Map<string, number>();
    const failure: Error = new Error("permanent failed");
    const results: BoundedBatchResult<string, string>[] =
      await runBoundedSettledBatch<string, string>({
        items: ["permanent", "ok"],
        maxConcurrent: 1,
        execute: async ({ item }): Promise<string> => {
          executions.set(item, (executions.get(item) ?? 0) + 1);
          if (item === "permanent") throw failure;
          return "done";
        },
      });

    expect([...executions]).toEqual([["permanent", 1], ["ok", 1]]);
    expect(results[0]).toEqual({ item: "permanent", index: 0, status: "rejected", reason: failure });
    expect(results[1]).toEqual({ item: "ok", index: 1, status: "fulfilled", value: "done" });
  });

  test("拒绝非法并发参数", async () => {
    await expect(runBoundedSettledBatch({
      items: [1],
      maxConcurrent: 0,
      execute: async (): Promise<number> => 1,
    })).rejects.toThrow("maxConcurrent");
  });

  /**
   * 这套批处理骨架承载黑名单补扫、批量踢人等不可逆动作：回调抛错时若把整批吞掉
   * 或让某一项静默消失，调用方拿到的是一份「都成功了」的假战报。
   */
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
