import { describe, expect, test } from "bun:test";
import { HOT_PATH_PROFILE_SCENARIOS } from "../../packages/consts/performance";
import {
  COMPARISON_HOT_PATH_SCENARIOS,
  PRODUCTION_HOT_PATH_SCENARIOS,
} from "../../scripts/perf/fullSuite/sections";
import {
  STORAGE_OPERATIONS,
  parseStorageOperation,
} from "../../scripts/perf/fullSuite/storageOperations";
import type { ScenarioName } from "../../scripts/perf/hotPaths/types";

describe("全量基准的热路径场景划分", () => {
  test("生产场景与实现对照互不重叠，且各自没有重复", () => {
    const production = new Set<ScenarioName>(PRODUCTION_HOT_PATH_SCENARIOS);
    const comparison = new Set<ScenarioName>(COMPARISON_HOT_PATH_SCENARIOS);
    expect(production.size).toBe(PRODUCTION_HOT_PATH_SCENARIOS.length);
    expect(comparison.size).toBe(COMPARISON_HOT_PATH_SCENARIOS.length);
    for (const scenario of comparison) expect(production.has(scenario)).toBe(false);
  });

  test("热路径门禁盯着的场景必须都在生产表里", () => {
    const production = new Set<string>(PRODUCTION_HOT_PATH_SCENARIOS);
    for (const scenario of HOT_PATH_PROFILE_SCENARIOS) {
      expect(production.has(scenario)).toBe(true);
    }
  });
});

describe("存储分区的操作表", () => {
  test("表里的每一项都能被子进程参数解析接受", () => {
    for (const operation of STORAGE_OPERATIONS) {
      expect(parseStorageOperation(operation)).toBe(operation);
    }
  });

  test("表外的值一律拒绝，不落到某个默认操作", () => {
    expect((): unknown => parseStorageOperation("storage-read"))
      .toThrow("Storage child expects one of");
    expect((): unknown => parseStorageOperation(undefined))
      .toThrow("Storage child expects one of");
  });
});
