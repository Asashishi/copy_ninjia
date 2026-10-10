import { describe, expect, test } from "bun:test";
import { BUN_INSPECTOR_ENVS } from "../../packages/consts/environment";
import { perfChildEnvironment } from "../../scripts/perf/childEnvironment";

const INHERITED_FIXTURE_ENV: string = "PERF_CHILD_INHERITED_FIXTURE";
const OVERRIDE_FIXTURE_ENV: string = "PERF_CHILD_OVERRIDE_FIXTURE";
const INSPECTOR_FIXTURE_VALUE: string = "tcp://127.0.0.1:1";

describe("性能子进程环境", () => {
  test("保留继承环境并叠加调用方变量，继承或叠加的 Bun 调试器接入变量都被去掉", () => {
    const previous: Readonly<Record<string, string | undefined>> = { ...process.env };
    const inspectorOverrides: Record<string, string> = {};
    try {
      for (const name of BUN_INSPECTOR_ENVS) {
        process.env[name] = INSPECTOR_FIXTURE_VALUE;
        inspectorOverrides[name] = INSPECTOR_FIXTURE_VALUE;
      }
      process.env[INHERITED_FIXTURE_ENV] = "inherited";
      const environment: Readonly<Record<string, string | undefined>> =
        perfChildEnvironment({ ...inspectorOverrides, [OVERRIDE_FIXTURE_ENV]: "override" });
      for (const name of BUN_INSPECTOR_ENVS) expect(name in environment).toBe(false);
      expect(environment[INHERITED_FIXTURE_ENV]).toBe("inherited");
      expect(environment[OVERRIDE_FIXTURE_ENV]).toBe("override");
    } finally {
      for (const name of [...BUN_INSPECTOR_ENVS, INHERITED_FIXTURE_ENV]) {
        const value: string | undefined = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
