import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  readHotPathGateCalibration,
  writeHotPathGateLastRun,
} from "../../scripts/perf/hotPaths/gateResult";
import type { HotPathGateCalibration } from "../../scripts/perf/hotPaths/gateResult";
import { HOT_PATH_PROFILE_SCENARIOS } from "../../packages/consts/performance";
import { assertHotPathMedianPolicyCoverage } from "../../scripts/perf/hotPaths/gateLimits";

/** 仓库根那份真实记录；门禁每次运行读的就是它。 */
const REPOSITORY_RESULT_PATH: string = join(import.meta.dir, "../../performance-result.json");

const scratchRoot: string = mkdtempSync(join(tmpdir(), "hot-path-gate-result-"));
afterAll((): void => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** 一份结构完整的最小记录；各用例只改动自己要破坏的那一处。 */
function validDocument(): Record<string, unknown> {
  return {
    hotPathProfileGate: {
      calibration: {
        runtime: {
          bunVersion: "1.4.0",
          bunRevision: "revision-test",
          notes: ["说明只给人看，门禁不消费"],
        },
        limits: {
          minProfileSamples: 50,
          maxGcPercent: 5,
          maxRssBytes: 402_653_184,
          maxSampledHeapGrowthBytes: 100_663_296,
          maxRetainedHeapGrowthBytes: 1_048_576,
          maxRetainedExtraMemoryGrowthBytes: 1_048_576,
          maxRetainedObjectGrowth: 4_096,
          notes: {},
        },
        scenarios: {
          "only-scenario": {
            medianNsPerOpReportThreshold: 100,
            measured: { slowestMedianNsPerOp: 80, processes: 13 },
            note: "",
          },
        },
        notes: [],
      },
      lastRun: null,
    },
    fullSuite: { lastRun: null },
  };
}

let documentIndex: number = 0;
/** 把一份记录写进独立临时文件，返回路径；用例之间不共享文件。 */
function writeDocument(document: unknown): string {
  documentIndex++;
  const path: string = join(scratchRoot, `result-${documentIndex}.json`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

describe("热路径门禁记录 performance-result.json", () => {
  test("仓库根那份记录能严格解析，且与默认场景表精确一一对应", async () => {
    const calibration: HotPathGateCalibration =
      await readHotPathGateCalibration(REPOSITORY_RESULT_PATH);

    expect(calibration.runtime.bunVersion.length).toBeGreaterThan(0);
    expect(calibration.runtime.bunRevision.length).toBeGreaterThan(0);
    expect(calibration.limits.maxGcPercent).toBeGreaterThan(0);
    // 这一条就是门禁启动时跑的那道契约：场景表与阈值表任一侧多一项都会抛错。
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      HOT_PATH_PROFILE_SCENARIOS,
      calibration.medianNsPerOpReportThresholds
    )).not.toThrow();
    // 「阈值必须解释得了它自己」「进程数是正整数」都由解析期强制，上面那次
    // 成功解析已经把它们钉住了；这里只确认每个默认场景都真的拿到了正阈值。
    for (const scenario of HOT_PATH_PROFILE_SCENARIOS) {
      expect(calibration.medianNsPerOpReportThresholds[scenario]).toBeGreaterThan(0);
    }
  });

  test("解析结果的阈值表在编译期只读，调用方不能覆写", async () => {
    const calibration: HotPathGateCalibration =
      await readHotPathGateCalibration(REPOSITORY_RESULT_PATH);
    const compileOnly: () => void = (): void => {
      // @ts-expect-error 逐场景纳秒软上报阈值经独立进程校准，调用方不允许覆写。
      calibration.medianNsPerOpReportThresholds["ad-capacity-reject"] = 1;
      // @ts-expect-error 硬上限同理：门禁运行中途改判据等于没有判据。
      calibration.limits.maxRssBytes = 1;
    };
    expect(compileOnly).toBeFunction();
  });

  test("容忍全量基准写的 fullSuite 节，但拒绝未知顶层节", async () => {
    // 同一份文件里还住着 perf:full 的记录。门禁既不读也不写它，但必须容忍它
    // 存在——否则全量基准跑完一次，热路径门禁就会整份拒绝解析。
    const withFullSuite: Record<string, unknown> = validDocument();
    withFullSuite.fullSuite = { lastRun: { rounds: 3 } };
    await expect(readHotPathGateCalibration(writeDocument(withFullSuite)))
      .resolves.toBeDefined();

    const unknownSection: Record<string, unknown> = validDocument();
    unknownSection.somethingElse = {};
    await expect(readHotPathGateCalibration(writeDocument(unknownSection)))
      .rejects.toThrow("$. must declare only these keys: hotPathProfileGate, fullSuite");

    const missingGate: Record<string, unknown> = { fullSuite: { lastRun: null } };
    await expect(readHotPathGateCalibration(writeDocument(missingGate)))
      .rejects.toThrow("$.hotPathProfileGate must be an object");
  });

  test("未知键、缺字段与类型不符一律拒绝，并点名字段路径", async () => {
    const unknownKey: Record<string, unknown> = validDocument();
    (unknownKey.hotPathProfileGate as Record<string, unknown>).extra = 1;
    await expect(readHotPathGateCalibration(writeDocument(unknownKey)))
      .rejects.toThrow("$.hotPathProfileGate must declare exactly these keys");

    const missingRevision: Record<string, unknown> = validDocument();
    const runtime = ((missingRevision.hotPathProfileGate as Record<string, unknown>)
      .calibration as Record<string, unknown>).runtime as Record<string, unknown>;
    runtime.bunRevision = "";
    await expect(readHotPathGateCalibration(writeDocument(missingRevision)))
      .rejects.toThrow(
        "$.hotPathProfileGate.calibration.runtime.bunRevision must be a non-empty string"
      );

    const badLimit: Record<string, unknown> = validDocument();
    const limits = ((badLimit.hotPathProfileGate as Record<string, unknown>)
      .calibration as Record<string, unknown>).limits as Record<string, unknown>;
    limits.maxRssBytes = 0;
    await expect(readHotPathGateCalibration(writeDocument(badLimit)))
      .rejects.toThrow(
        "$.hotPathProfileGate.calibration.limits.maxRssBytes must be a finite number greater than 0"
      );
  });

  test("阈值低于自己的来源读数时拒绝，不静默沿用", async () => {
    const document: Record<string, unknown> = validDocument();
    const scenarios = ((document.hotPathProfileGate as Record<string, unknown>)
      .calibration as Record<string, unknown>).scenarios as Record<string, unknown>;
    (scenarios["only-scenario"] as Record<string, unknown>)
      .medianNsPerOpReportThreshold = 79;

    await expect(readHotPathGateCalibration(writeDocument(document)))
      .rejects.toThrow("must be at least its own measured.slowestMedianNsPerOp (80)");
  });

  test("非严格 JSON 直接失败，不退回默认值", async () => {
    const path: string = join(scratchRoot, "broken.json");
    writeFileSync(path, "{ not json }\n", "utf8");

    await expect(readHotPathGateCalibration(path))
      .rejects.toThrow("could not be read as strict JSON");
  });

  test("回写只覆盖 lastRun，calibration 与 fullSuite 节都原样保留", async () => {
    const document: Record<string, unknown> = validDocument();
    document.fullSuite = { lastRun: { rounds: 3 } };
    const path: string = writeDocument(document);

    await writeHotPathGateLastRun(
      path,
      { bunRevision: "revision-test", scenarios: [] }
    );

    const reloaded: HotPathGateCalibration = await readHotPathGateCalibration(path);
    expect(reloaded.runtime.bunRevision).toBe("revision-test");
    expect(reloaded.limits.maxRssBytes).toBe(402_653_184);
    // 说明字段与另一套基准的记录都不在解析结果里，只能从原文确认没被回写抹掉。
    const raw: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
    const gate = raw.hotPathProfileGate as Record<string, unknown>;
    const calibration = gate.calibration as Record<string, unknown>;
    const runtime = calibration.runtime as Record<string, unknown>;
    expect(runtime.notes).toEqual(["说明只给人看，门禁不消费"]);
    expect(gate.lastRun).toEqual({ bunRevision: "revision-test", scenarios: [] });
    expect(raw.fullSuite).toEqual({ lastRun: { rounds: 3 } });
  });
});
