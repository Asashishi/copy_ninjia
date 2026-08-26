import { describe, expect, test } from "bun:test";
import {
  runHotPathSection,
} from "../../scripts/perf/fullSuite/sections";
import type {
  SectionContext,
  SectionDependencies,
} from "../../scripts/perf/fullSuite/sections";
import type { SpawnChildOptions } from "../../scripts/perf/fullSuite/child";
import type { HotPathRound } from "../../scripts/perf/fullSuite/types";

function hotPathRound(
  medianNsPerOp: number,
  iterations: number,
  samplesNsPerOp: readonly number[]
): HotPathRound {
  return {
    scenario: "self-sent-empty",
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    iterations,
    samplesNsPerOp,
    medianNsPerOp,
    peakSampledRssBytes: 1_000,
    retainedHeapDelta: 20,
    retainedObjectDelta: 2,
  };
}

describe("全量基准分区编排", () => {
  test("注入的 child runner 按轮聚合，并按真实样本数登记操作与足迹", async (): Promise<void> => {
    const pending: HotPathRound[] = [
      hotPathRound(10, 5, [9, 11]),
      hotPathRound(20, 5, [18, 20, 22]),
    ];
    const removed: string[] = [];
    const operations: number[] = [];
    const footprints: number[] = [];
    let nextRoot: number = 0;
    const dependencies: SectionDependencies = {
      spawnJsonChild: async <TResult>(_options: SpawnChildOptions): Promise<TResult> =>
        pending.shift() as unknown as TResult,
      createRuntimeRoot: (_runRoot: string): string => `/fixture/runtime-${nextRoot++}`,
      measureDirectoryFootprint: (runtimeRoot: string) => ({
        bytes: runtimeRoot.endsWith("0") ? 100 : 200,
        files: 1,
      }),
      removeMockPath: (runtimeRoot: string): void => {
        removed.push(runtimeRoot);
      },
    };
    const context: SectionContext = {
      runRoot: "/fixture",
      rounds: 2,
      onProgress: (_message: string): void => {},
      recordIo: (_io): void => {},
      recordOperations: (count: number): void => {
        operations.push(count);
      },
      recordFootprint: (footprint): void => {
        footprints.push(footprint.bytes);
      },
      dependencies,
    };

    const section = await runHotPathSection(
      context,
      "hot-path",
      ["self-sent-empty"]
    );

    expect(section.entries[0]?.metrics[0]).toEqual(expect.objectContaining({
      metric: "medianLatency",
      samples: 2,
      mean: 15,
      min: 10,
      max: 20,
    }));
    expect(section.entries[0]?.metrics[1]).toEqual(expect.objectContaining({
      metric: "throughput",
      mean: 75_000_000,
    }));
    expect(operations).toEqual([10, 15]);
    expect(footprints).toEqual([100, 200]);
    expect(removed).toEqual(["/fixture/runtime-0", "/fixture/runtime-1"]);
  });

  test("child 失败仍在 finally 中计量并删除本轮运行时根", async (): Promise<void> => {
    const measured: string[] = [];
    const removed: string[] = [];
    const dependencies: SectionDependencies = {
      spawnJsonChild: async <TResult>(_options: SpawnChildOptions): Promise<TResult> => {
        throw new Error("child failed");
      },
      createRuntimeRoot: (_runRoot: string): string => "/fixture/runtime-failed",
      measureDirectoryFootprint: (runtimeRoot: string) => {
        measured.push(runtimeRoot);
        return { bytes: 0, files: 0 };
      },
      removeMockPath: (runtimeRoot: string): void => {
        removed.push(runtimeRoot);
      },
    };
    const context: SectionContext = {
      runRoot: "/fixture",
      rounds: 1,
      onProgress: (_message: string): void => {},
      recordIo: (_io): void => {},
      recordOperations: (_count: number): void => {},
      recordFootprint: (_footprint): void => {},
      dependencies,
    };

    await expect(runHotPathSection(
      context,
      "hot-path",
      ["self-sent-empty"]
    )).rejects.toThrow("child failed");
    expect(measured).toEqual(["/fixture/runtime-failed"]);
    expect(removed).toEqual(["/fixture/runtime-failed"]);
  });

  test("热路径子进程的 Bun 构建不一致时拒绝聚合", async (): Promise<void> => {
    const mismatched: HotPathRound = {
      ...hotPathRound(10, 1, [10]),
      bunRevision: "different-revision",
    };
    const dependencies: SectionDependencies = {
      spawnJsonChild: async <TResult>(_options: SpawnChildOptions): Promise<TResult> =>
        mismatched as unknown as TResult,
      createRuntimeRoot: (_runRoot: string): string => "/fixture/runtime-mismatch",
      measureDirectoryFootprint: (_runtimeRoot: string) => ({ bytes: 0, files: 0 }),
      removeMockPath: (_runtimeRoot: string): void => {},
    };
    const context: SectionContext = {
      runRoot: "/fixture",
      rounds: 1,
      onProgress: (_message: string): void => {},
      recordIo: (_io): void => {},
      recordOperations: (_count: number): void => {},
      recordFootprint: (_footprint): void => {},
      dependencies,
    };

    await expect(runHotPathSection(
      context,
      "hot-path",
      ["self-sent-empty"]
    )).rejects.toThrow("child ran Bun");
  });
});
