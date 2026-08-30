import { createApplicationLifecycle } from "./packages/app/lifecycle";
import type { ApplicationLifecycle } from "./packages/app/lifecycle";

const application: ApplicationLifecycle = createApplicationLifecycle();

/** 供测试或嵌入式调用，不接管宿主进程。 */
export function runTest(): Promise<void> {
  return application.run("test");
}

/** 生产入口会额外安装进程级信号/异常 handler，并保证最终 dispose。 */
export function runApplication(): Promise<void> {
  return application.run("main");
}

if (import.meta.main) await runApplication();
