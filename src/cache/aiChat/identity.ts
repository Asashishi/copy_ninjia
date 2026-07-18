import type { AiBotInfo } from "../../types";

/** Worker 自身账号身份：主线程 init 后注入，Worker 重建时回到 null。 */
export const botInfoState: { current: AiBotInfo | null } = { current: null };

/** Worker dispose/测试隔离时清空身份。 */
export function resetAiChatIdentityCache(): void {
  botInfoState.current = null;
}
