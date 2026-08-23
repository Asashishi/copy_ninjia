import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  PERFORMANCE_RESULT_PATH,
  writePerformanceResultEntry,
} from "../../scripts/perf/performanceResult";

const scratchRoot: string = mkdtempSync(join(tmpdir(), "performance-result-"));
afterAll((): void => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

let documentIndex: number = 0;
/** 把一份记录写进独立临时文件，返回路径；用例之间不共享文件。 */
function writeDocument(document: unknown): string {
  documentIndex++;
  const path: string = join(scratchRoot, `result-${documentIndex}.json`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

function reload(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("performance-result.json 的共享写入边界", () => {
  test("常量指向仓库根那份真实记录，且它确实存在", () => {
    expect(PERFORMANCE_RESULT_PATH.endsWith("performance-result.json")).toBeTrue();
    expect(existsSync(PERFORMANCE_RESULT_PATH)).toBeTrue();
  });

  test("只换自己那一格，另一节与其中的人写说明原样保留", () => {
    const path: string = writeDocument({
      hotPathProfileGate: {
        calibration: { runtime: { notes: ["给人看的说明"] } },
        lastRun: { marker: "gate" },
      },
      fullSuite: { lastRun: null },
    });

    writePerformanceResultEntry({
      path,
      section: "fullSuite",
      entry: "lastRun",
      value: { rounds: 3 },
    });

    const document: Record<string, unknown> = reload(path);
    const gate = document.hotPathProfileGate as Record<string, unknown>;
    const calibration = gate.calibration as Record<string, unknown>;
    const runtime = calibration.runtime as Record<string, unknown>;
    // 两套基准在不同时刻跑；后写的那个绝不能把先写的那节重建掉。
    expect(runtime.notes).toEqual(["给人看的说明"]);
    expect(gate.lastRun).toEqual({ marker: "gate" });
    expect((document.fullSuite as Record<string, unknown>).lastRun).toEqual({ rounds: 3 });
  });

  test("节还不存在时创建它，不动其余内容", () => {
    const path: string = writeDocument({ hotPathProfileGate: { lastRun: null } });

    writePerformanceResultEntry({
      path,
      section: "fullSuite",
      entry: "lastRun",
      value: { rounds: 1 },
    });

    const document: Record<string, unknown> = reload(path);
    expect(document.fullSuite).toEqual({ lastRun: { rounds: 1 } });
    expect(document.hotPathProfileGate).toEqual({ lastRun: null });
  });

  test("节存在但不是对象时失败，不覆盖也不重建", () => {
    const path: string = writeDocument({ hotPathProfileGate: {}, fullSuite: 42 });

    expect((): void => writePerformanceResultEntry({
      path,
      section: "fullSuite",
      entry: "lastRun",
      value: {},
    })).toThrow("$.fullSuite must be an object");
    // 失败后原文不变：写坏的地方留在原地等人看，不被静默重建掩盖。
    expect(reload(path).fullSuite).toBe(42);
  });

  test("非严格 JSON 与非对象顶层都直接失败", () => {
    const brokenPath: string = join(scratchRoot, "broken.json");
    writeFileSync(brokenPath, "{ not json }\n", "utf8");
    expect((): void => writePerformanceResultEntry({
      path: brokenPath,
      section: "fullSuite",
      entry: "lastRun",
      value: {},
    })).toThrow("could not be read as strict JSON");

    const arrayPath: string = writeDocument([]);
    expect((): void => writePerformanceResultEntry({
      path: arrayPath,
      section: "fullSuite",
      entry: "lastRun",
      value: {},
    })).toThrow("$. must be a JSON object");
  });
});
