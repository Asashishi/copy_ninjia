import { ensureStickerCatalogs } from "../../aiChat/ai/stickers/catalog";
import { refreshChatMoods } from "../../aiChat/ai/mood";
import { reloadAgentDeploymentConfig } from "../../aiChat/provider";
import { aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import { adoptMoodConfig } from "../../config/mood";
import { adoptStickerConfig } from "../../config/stickers";
import type { AiConfigReloadMessage } from "../../types/aiChat/protocol";

/**
 * AI Worker 接管主线程热重载投递的部署配置（协议见 AiConfigReloadMessage）。
 *
 * 每个变化的领域先整体替换本线程 holder，再失效按旧快照派生的运行时状态：
 * agent 段见 aiChat/provider.ts 的 reloadAgentDeploymentConfig；心情按档位名换成
 * 新快照；贴纸白名单替换后为新加入的包启动目录对账，停机排空期间不再启动后台
 * 任务。移出白名单的包不再出现在贴纸工具里，其目录留到下次启动由 Disk I/O 恢复
 * 按白名单对账。
 */
export function applyAiChatConfigReload(msg: AiConfigReloadMessage): void {
  if (msg.agent !== undefined) reloadAgentDeploymentConfig(msg.agent);
  if (msg.mood !== undefined) {
    adoptMoodConfig(msg.mood);
    refreshChatMoods();
  }
  if (msg.stickers !== undefined) {
    adoptStickerConfig(msg.stickers);
    if (!aiChatWorkerQuiescing.current) ensureStickerCatalogs(msg.stickers.packs);
  }
}
