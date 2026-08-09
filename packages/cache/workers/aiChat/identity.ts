import type { AiBotInfo } from "../../../types/aiChat/protocol";

/**
 * AI Worker 自身账号身份（packages/workers/aiChatWorker.ts）的内存状态；同目录
 * 下多个回复流水线子模块只读取，写入只发生在 aiChatWorker.ts 的 init 处理。
 */

/** Worker 自身账号身份：主线程 init 后注入，Worker 重建时回到 null。 */
export const botInfoState: { current: AiBotInfo | null } = { current: null };

/** 超级管理员身份：主线程随 init 注入，只用于重媒体冷却豁免。 */
export const superAdminUserIdState: { current: number | null } = { current: null };

/** Worker dispose/测试隔离时清空身份。 */
export function resetAiChatIdentityCache(): void {
  botInfoState.current = null;
  superAdminUserIdState.current = null;
}
