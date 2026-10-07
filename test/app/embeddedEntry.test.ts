import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApplicationRunMode } from "../../packages/types/lifecycle";

// index.ts 在模块加载时就构造一次 ApplicationLifecycle；替身必须先于 import
// 装好，测试才不会碰到真实的数据根、锁文件与 Worker。
const runs: ApplicationRunMode[] = [];
let runResult: () => Promise<void> = async (): Promise<void> => {};

mock.module("../../packages/app/lifecycle", () => ({
  ApplicationLifecycle: class {
    run(mode: ApplicationRunMode): Promise<void> {
      runs.push(mode);
      return runResult();
    }
  },
}));

const { application } = await import("../../index");

/**
 * import 刚完成、任何用例开跑之前的运行记录快照；`runs` 是模块级共享数组，用例调一次入口就往里推一条，
 * 「import 本身不启动任何东西」以这一刻的快照为准。
 */
const RUNS_AFTER_IMPORT: readonly ApplicationRunMode[] = [...runs];

// 两个用例都调运行入口，共享的 runs 逐例清空；runResult 一并复位。
beforeEach(() => {
  runs.length = 0;
  runResult = async (): Promise<void> => {};
});

describe("嵌入式与生产入口", () => {
  test("两个入口只选运行模式，import 本身不启动任何东西", async () => {
    expect(RUNS_AFTER_IMPORT).toEqual([]);

    await application.run("test");
    expect(runs).toEqual(["test"]);

    await application.run("main");
    expect(runs).toEqual(["test", "main"]);
  });

  test("application.run(\"test\") 把运行异常原样交还调用方", async () => {
    const failure: Error = new Error("startup failed");
    runResult = (): Promise<void> => Promise.reject(failure);
    try {
      await expect(application.run("test")).rejects.toBe(failure);
    } finally {
      runResult = async (): Promise<void> => {};
    }
  });
});
