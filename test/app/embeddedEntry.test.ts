import { describe, expect, mock, test } from "bun:test";
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

describe("嵌入式与生产入口", () => {
  test("两个入口只选运行模式，import 本身不启动任何东西", async () => {
    expect(runs).toEqual([]);

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
