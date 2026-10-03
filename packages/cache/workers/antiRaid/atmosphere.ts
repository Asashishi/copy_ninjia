/** owner: workers/antiRaid。 */

import type { Atmosphere } from "../../../types/atmosphere";

/**
 * 主线程启动总闸确定的本进程通知风格，容量一个枚举。
 * agentConfig 载荷全量注入；业务读取只读，重建由 main 在业务消息前重放，停止时清空。
 * 未注入时为 null，读取使用配置缺省风格，不沿用上一个 Worker 的值。
 * 跨线程恢复顺序见 docs/cn/04-invariants.md。
 */
export const atmosphereState: { current: Atmosphere | null } = { current: null };
