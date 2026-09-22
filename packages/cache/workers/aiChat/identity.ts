import type { Atmosphere } from "../../../types/atmosphere";
import type { AiBotInfo } from "../../../types/aiChat/protocol";

/**
 * AI Worker 自身账号身份（packages/workers/aiChatWorker.ts）的内存状态；同目录
 * 下多个回复流水线子模块只读取，写入只发生在 aiChatWorker.ts 的 init 处理；
 * 容量固定为机器人身份和超级管理员身份及通知风格三个 holder。
 */

/** Worker 自身账号身份：主线程 init 后注入，Worker 重建时回到 null。 */
export const botInfoState: { current: AiBotInfo | null } = { current: null };

/** 超级管理员身份：主线程随 init 注入，只用于重媒体冷却豁免。 */
export const superAdminUserIdState: { current: number | null } = { current: null };

/** Worker dispose/测试隔离时清空身份。 */
export function resetAiChatIdentityCache(): void {
  botInfoState.current = null;
  superAdminUserIdState.current = null;
  defaultAtmosphereState.current = null;
}

/**
 * owner: workers/aiChat。主线程启动快照的默认通知风格，容量一个枚举。
 * 初始化载荷全量注入；业务读取只读，重建由 main 在业务消息前重放，停止时清空。
 * 未注入时为 null，读取使用配置缺省风格，不沿用上一个 Worker 的值。
 */
export const defaultAtmosphereState: { current: Atmosphere | null } = { current: null };
