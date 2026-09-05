import { join } from "node:path";
import { isPlainRecord } from "../../../packages/libs/record";
import { readHotPathGateCalibration } from "./gateResult";
import type { HotPathGateRuntimeCalibration } from "./gateResult";

/** 运行时一致性检查的可注入输入，测试不修改宿主 Bun 属性。 */
export interface RuntimeCalibrationCheckOptions {
  readonly projectRoot: string;
  readonly runtime?: HotPathGateRuntimeCalibration;
}

/** 在创建夹具和昂贵子进程之前核对 manifest、当前 Bun 与校准构建。 */
export async function collectRuntimeCalibrationProblems({
  projectRoot,
  runtime = { bunVersion: Bun.version, bunRevision: Bun.revision },
}: RuntimeCalibrationCheckOptions): Promise<readonly string[]> {
  const manifestPath: string = join(projectRoot, "package.json");
  const recordPath: string = join(projectRoot, "performance-result.json");
  const manifest: unknown = await Bun.file(manifestPath).json();
  const calibration: HotPathGateRuntimeCalibration = (await readHotPathGateCalibration(recordPath)).runtime;
  const problems: string[] = [];
  if (!isPlainRecord(manifest) || manifest.packageManager !== `bun@${calibration.bunVersion}`) {
    problems.push(`${manifestPath}: $.packageManager must equal bun@${calibration.bunVersion}; ` +
      "remeasure calibration when changing the Bun version");
  }
  if (runtime.bunVersion !== calibration.bunVersion || runtime.bunRevision !== calibration.bunRevision) {
    problems.push(`${recordPath}: $.hotPathProfileGate.calibration.runtime must match ` +
      `Bun ${runtime.bunVersion} (${runtime.bunRevision}); remeasure before running the gate`);
  }
  return problems;
}
