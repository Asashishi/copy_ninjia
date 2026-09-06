import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRuntimeCalibrationProblems } from "../../scripts/perf/hotPaths/gateRuntime";

const roots: string[] = [];
interface CalibrationFixture {
  readonly hotPathProfileGate: {
    readonly calibration: {
      readonly runtime: { bunVersion: string; bunRevision: string };
    };
  };
}
async function fixture(packageManager: unknown = "bun@1.4.2"): Promise<string> {
  const root: string = mkdtempSync(join(tmpdir(), "runner-runtime-check-"));
  roots.push(root);
  const record: CalibrationFixture = await Bun.file("performance-result.json").json();
  record.hotPathProfileGate.calibration.runtime.bunVersion = "1.4.2";
  record.hotPathProfileGate.calibration.runtime.bunRevision = "expected";
  await Bun.write(join(root, "performance-result.json"), JSON.stringify(record));
  await Bun.write(join(root, "package.json"), JSON.stringify({ packageManager }));
  return root;
}
afterEach((): void => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

test("manifest、Bun 版本和构建一致时通过，不要求历史 fullSuite 更新", async (): Promise<void> => {
  expect(await collectRuntimeCalibrationProblems({
    projectRoot: await fixture(), runtime: { bunVersion: "1.4.2", bunRevision: "expected" },
  })).toEqual([]);
});
test("manifest 漂移或缺少 packageManager 时在昂贵门禁前失败", async (): Promise<void> => {
  for (const manager of ["bun@1.4.0", null]) {
    expect(await collectRuntimeCalibrationProblems({
      projectRoot: await fixture(manager), runtime: { bunVersion: "1.4.2", bunRevision: "expected" },
    })).toEqual([expect.stringContaining("$.packageManager must equal bun@1.4.2")]);
  }
});
test("版本或同版本不同构建必须重新校准", async (): Promise<void> => {
  for (const runtime of [
    { bunVersion: "1.4.0", bunRevision: "expected" },
    { bunVersion: "1.4.2", bunRevision: "different" },
  ]) {
    expect(await collectRuntimeCalibrationProblems({ projectRoot: await fixture(), runtime }))
      .toEqual([expect.stringContaining("calibration.runtime must match")]);
  }
});
