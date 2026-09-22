import type { Api } from "grammy";
import { syncAiChatPersona } from "../aiChat/workerBridge";
import { syncAntiRaidAtmosphere } from "../antiRaid/workerBridge/controller";
import { syncChatCommandMenu } from "../app/commandMenu";

/**
 * 群人设发生变化后把三处对外表现对齐到当前 `ChatState.aiPersona`：
 * AI Chat Worker 的人设快照、Anti-Raid Worker 的文案风格，以及该群的命令菜单。
 *
 * 顺序固定：两个 Worker 快照先就位，命令菜单最后发——菜单那一步是真实出站
 * 请求，先发它会让失败路径上两个 Worker 停在旧人设上。前两步同步完成且不抛错；
 * 只有最后一步会拒绝，调用方据此决定是整条上抛还是记一条日志。
 *
 * 调用点：`/prompt`（写入与清除人设）、`/init disable` 的拆除收尾，以及机器人
 * 被移出群之后的状态清理（那一路由 app/registerHandlers.ts 注入，见
 * types/commands.ts 的 ChatPersonaSurfaceSync）。
 */
export async function syncChatPersonaSurfaces(api: Api, chatId: number): Promise<void> {
  syncAiChatPersona(chatId);
  syncAntiRaidAtmosphere(chatId);
  await syncChatCommandMenu(api, chatId);
}
