import { describe, expect, test } from "bun:test";
import { HOT_PATH_PROFILE_SCENARIOS } from "../../packages/consts/performance";
import {
  CHAIN_NAMES,
  CONTAINER_ALGORITHM_SCENARIOS,
  PRODUCTION_HOT_PATH_SCENARIOS,
} from "../../scripts/perf/fullSuite/sections";
import { benchmarkEntryCopy } from "../../scripts/perf/fullSuite/markdownEntryCopy";
import {
  STORAGE_OPERATIONS,
  parseStorageOperation,
} from "../../scripts/perf/fullSuite/storageOperations";
import type { ScenarioName } from "../../scripts/perf/hotPaths/types";
import type { BenchmarkEntryCopy } from "../../scripts/perf/fullSuite/markdownEntryCopy";
import type { Language } from "../../scripts/perf/fullSuite/markdownCopy";

const COLD_START_AND_CAPACITY_IDS: readonly string[] = [
  "module-graph",
  "instance-lock",
  "orphan-cleanup",
  "state-load",
  "deployment-inputs",
  "disk-io-init",
  "persisted-load",
  "hydrate",
  "ready-total",
  "snapshot",
  "capacity",
];

describe("全量基准的热路径场景划分", () => {
  test("生产场景与容器场景互不重叠，且各自没有重复", () => {
    const production = new Set<ScenarioName>(PRODUCTION_HOT_PATH_SCENARIOS);
    const containers = new Set<ScenarioName>(CONTAINER_ALGORITHM_SCENARIOS);
    expect(production.size).toBe(PRODUCTION_HOT_PATH_SCENARIOS.length);
    expect(containers.size).toBe(CONTAINER_ALGORITHM_SCENARIOS.length);
    for (const scenario of containers) expect(production.has(scenario)).toBe(false);
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

describe("性能文档的人类可读名称", () => {
  test("三种语言覆盖全量基准当前会输出的每一个稳定 id", () => {
    const ids: readonly string[] = [
      ...COLD_START_AND_CAPACITY_IDS,
      ...PRODUCTION_HOT_PATH_SCENARIOS,
      ...CONTAINER_ALGORITHM_SCENARIOS,
      ...CHAIN_NAMES,
      ...STORAGE_OPERATIONS,
    ];
    for (const language of ["zh", "en", "ja"] as const satisfies readonly Language[]) {
      const copy: BenchmarkEntryCopy = benchmarkEntryCopy(language);
      for (const id of ids) expect(copy.labels[id]?.length).toBeGreaterThan(0);
    }
  });
});
