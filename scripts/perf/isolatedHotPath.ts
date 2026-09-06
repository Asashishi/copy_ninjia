/** 为单个专项场景准备隔离根，并复用热路径入口执行三轮独立进程测量。 */

import { join } from "node:path";
import { HOT_PATH_PROFILE_REPEATS } from "../../packages/consts/performance";
import {
  createHotPathGateFixture,
  createHotPathGateRuntimeRoot,
  hotPathGateChildEnvironment,
  removeHotPathGateFixture,
  removeHotPathGateRuntimeRoot,
} from "./hotPaths/gateFixture";
import type { HotPathGateFixture } from "./hotPaths/gateFixture";

const fixture: HotPathGateFixture = await createHotPathGateFixture();
try {
  for (let round: number = 0; round < HOT_PATH_PROFILE_REPEATS; round++) {
    const runtimeRoot: string = createHotPathGateRuntimeRoot(fixture);
    try {
      const child: Bun.Subprocess<"ignore", "inherit", "inherit"> = Bun.spawn(
        [Bun.argv[0]!, join(import.meta.dir, "hotPaths.ts"), ...Bun.argv.slice(2)],
        {
          env: hotPathGateChildEnvironment(fixture, runtimeRoot),
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }
      );
      const code: number = await child.exited;
      if (code !== 0) throw new Error(`Hot-path measurement round ${round + 1} exited with ${code}.`);
    } finally {
      removeHotPathGateRuntimeRoot(runtimeRoot);
    }
  }
} finally {
  removeHotPathGateFixture(fixture);
}
