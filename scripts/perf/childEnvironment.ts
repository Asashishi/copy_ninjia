/** 性能脚本子进程的环境；基准、门禁与专项测量的子进程都从这里取环境。 */

import { BUN_INSPECTOR_ENVS } from "../../packages/consts/environment";

/** 继承父进程环境并叠加调用方变量，再去掉 `BUN_INSPECTOR_ENVS`；子进程只有主线程一个 JSC 堆。 */
export function perfChildEnvironment(
  overrides: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = { ...process.env, ...overrides };
  for (const name of BUN_INSPECTOR_ENVS) delete environment[name];
  return environment;
}
