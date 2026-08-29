import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../packages/consts/environment";
import {
  createHotPathGateFixture,
  createHotPathGateRuntimeRoot,
  hotPathGateChildEnvironment,
  removeHotPathGateFixture,
  removeHotPathGateRuntimeRoot,
} from "../../scripts/perf/hotPaths/gateFixture";
import type { HotPathGateFixture } from
  "../../scripts/perf/hotPaths/gateFixture";

describe("热路径门禁隔离根", () => {
  test("子进程读取严格配置与独占数据根，清理后不留痕", async (): Promise<void> => {
    const fixture: HotPathGateFixture = await createHotPathGateFixture();
    const runtimeRoot: string = createHotPathGateRuntimeRoot(fixture);
    try {
      const environment: Readonly<Record<string, string | undefined>> =
        hotPathGateChildEnvironment(fixture, runtimeRoot);
      expect(environment[CONFIG_ROOT_ENV]).toBe(fixture.configRoot);
      expect(environment[RUNTIME_DATA_ROOT_ENV]).toBe(runtimeRoot);
      expect(existsSync(fixture.configRoot)).toBe(true);
      expect(existsSync(runtimeRoot)).toBe(true);
      removeHotPathGateRuntimeRoot(runtimeRoot);
      expect(existsSync(runtimeRoot)).toBe(false);
    } finally {
      removeHotPathGateFixture(fixture);
    }
    expect(existsSync(fixture.runRoot)).toBe(false);
  });
});
