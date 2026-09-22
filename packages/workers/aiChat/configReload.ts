import { ensureStickerCatalogs, pruneStickerCatalogs } from "../../aiChat/ai/stickers/catalog";
import { pruneStickerSets } from "../../aiChat/ai/stickers/sets";
import { refreshChatMoods } from "../../aiChat/ai/mood";
import { reloadAgentDeploymentConfig } from "../../aiChat/provider";
import { invalidateStickerMenu } from "../../cache/workers/aiChat/stickers/menu";
import { aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import { adoptMoodConfig } from "../../config/mood";
import { adoptStickerConfig } from "../../config/stickers";
import type { AiConfigReloadMessage } from "../../types/aiChat/protocol";

/**
 * AI Worker 接管主线程热重载投递的部署配置（协议见 AiConfigReloadMessage）。
 *
 * 每个变化的领域先整体替换本线程 holder，再失效按旧快照派生的运行时状态：
 * agent 段见 aiChat/provider.ts 的 reloadAgentDeploymentConfig；心情按档位名换成
 * 新快照；贴纸白名单替换后显式失效菜单，清理退出白名单的集合正负缓存，
 * 并剪枝已完成生成与上报的目录。随后为当前白名单启动目录对账，同包任务去重；
 * 停机排空期间不启动后台任务。目录文件由下次 Disk I/O 启动恢复按白名单对账。
 * 跨线程保留与清理约束见 docs/cn/04-invariants.md。
 */
export function applyAiChatConfigReload(msg: AiConfigReloadMessage): void {
  if (msg.agent !== undefined) reloadAgentDeploymentConfig(msg.agent);
  if (msg.mood !== undefined) {
    adoptMoodConfig(msg.mood);
    refreshChatMoods();
  }
  if (msg.stickers !== undefined) {
    adoptStickerConfig(msg.stickers);
    invalidateStickerMenu();
    pruneStickerSets(msg.stickers.packs);
    pruneStickerCatalogs(msg.stickers.packs);
    if (!aiChatWorkerQuiescing.current) ensureStickerCatalogs(msg.stickers.packs);
  }
}
