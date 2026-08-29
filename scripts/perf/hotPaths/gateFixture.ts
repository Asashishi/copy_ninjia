/** 热路径门禁子进程的隔离配置与运行时数据根。 */

import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../../packages/consts/environment";
import {
  createBenchmarkConfigRoot,
  createRunRoot,
  createRuntimeRoot,
  removeMockPath,
} from "../fullSuite/mockRoot";

/** 一次热路径门禁共用的运行目录与严格配置副本。 */
export interface HotPathGateFixture {
  readonly runRoot: string;
  readonly configRoot: string;
}

/** 建立门禁级隔离根；配置复制失败时同步清理已经创建的 run-*。 */
export async function createHotPathGateFixture(): Promise<HotPathGateFixture> {
  const runRoot: string = createRunRoot();
  try {
    return {
      runRoot,
      configRoot: await createBenchmarkConfigRoot(runRoot),
    };
  } catch (error: unknown) {
    removeMockPath(runRoot);
    throw error;
  }
}

/** 为一个 profile 或 retained 子进程建立独占运行时数据根。 */
export function createHotPathGateRuntimeRoot(
  fixture: HotPathGateFixture
): string {
  return createRuntimeRoot(fixture.runRoot);
}

/** 子进程只读取隔离配置和数据根，同时保留与父进程相同的其余环境。 */
export function hotPathGateChildEnvironment(
  fixture: HotPathGateFixture,
  runtimeRoot: string
): Readonly<Record<string, string | undefined>> {
  return {
    ...process.env,
    [CONFIG_ROOT_ENV]: fixture.configRoot,
    [RUNTIME_DATA_ROOT_ENV]: runtimeRoot,
  };
}

/** 清理单个子进程数据根；路径越出 performance/ 时由共用边界拒绝。 */
export function removeHotPathGateRuntimeRoot(runtimeRoot: string): void {
  removeMockPath(runtimeRoot);
}

/** 清理整次门禁根及其中的严格配置副本。 */
export function removeHotPathGateFixture(fixture: HotPathGateFixture): void {
  removeMockPath(fixture.runRoot);
}
