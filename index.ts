import { createApplicationLifecycle } from "./packages/app/lifecycle";
import type { ApplicationLifecycle } from "./packages/app/lifecycle";

const application: ApplicationLifecycle = createApplicationLifecycle();

/** 供测试或嵌入式调用显式驱动初始化与轮询。 */
export async function main(): Promise<void> {
  try {
    await application.init();
    await application.wait();
  } finally {
    await application.dispose();
  }
}

/** 生产入口会额外安装进程级信号/异常 handler，并保证最终 dispose。 */
export function runApplication(): Promise<void> {
  return application.run();
}

if (import.meta.main) void runApplication();
