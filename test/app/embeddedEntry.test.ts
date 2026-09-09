import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApplicationRunMode } from "../../packages/types/lifecycle";

// index.ts 在模块加载时就构造一次 ApplicationLifecycle；替身必须先于 import
// 装好，测试才不会碰到真实的数据根、锁文件与 Worker。
const runs: ApplicationRunMode[] = [];
let runResult: () => Promise<void> = async (): Promise<void> => {};

mock.module("../../packages/app/lifecycle", () => ({
  createApplicationLifecycle: (): { run: (mode: ApplicationRunMode) => Promise<void> } => ({
    run: (mode: ApplicationRunMode): Promise<void> => {
      runs.push(mode);
      return runResult();
    },
  }),
}));

const { runApplication, runTest } = await import("../../index");

/**
 * import 刚完成、任何用例开跑之前的运行记录快照。
 *
 * 「import 本身不启动任何东西」只有这一刻能作证：`runs` 是模块级共享数组，
 * 用例调一次入口就往里推一条，`bun test --randomize` 下先跑的用例已经把它写脏了。
 */
const RUNS_AFTER_IMPORT: readonly ApplicationRunMode[] = [...runs];

// 两个用例都调运行入口，共享的 runs 必须逐例清空；runResult 一并复位，避免
// 「原样交还异常」那条留下的 reject 实现漏给随机顺序里排在它后面的用例。
beforeEach(() => {
  runs.length = 0;
  runResult = async (): Promise<void> => {};
});

describe("嵌入式与生产入口", () => {
  test("两个入口只选运行模式，import 本身不启动任何东西", async () => {
    expect(RUNS_AFTER_IMPORT).toEqual([]);

    await runTest();
    expect(runs).toEqual(["test"]);

    await runApplication();
    expect(runs).toEqual(["test", "main"]);
  });

  test("runTest 把运行异常原样交还调用方", async () => {
    const failure: Error = new Error("startup failed");
    runResult = (): Promise<void> => Promise.reject(failure);
    try {
      await expect(runTest()).rejects.toBe(failure);
    } finally {
      runResult = async (): Promise<void> => {};
    }
  });
});
