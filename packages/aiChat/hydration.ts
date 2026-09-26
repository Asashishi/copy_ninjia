/**
 * AI Worker 的状态灌入：启动恢复与 config/dynamic/ 热重载恢复共用同一份主线程镜像。
 *
 * 启动时 diskIOWorker 恢复出的 AI 记忆与贴纸目录一律先写进主线程镜像
 * （cache/main/aiChat.ts 的 latestAiMemories / latestStickerCatalogs，也是双向崩溃
 * 重放的来源，见 aiChat/workerBridge.ts 模块头注）。AI 前提可用时立刻投给 Worker；
 * 不可用时 Worker 不启动、一条记忆都不删，镜像留到热重载补齐前提后由
 * resumeAiChat 投递。镜像之后的删除（`/clear_context`、`/ai_chat disable`、群
 * teardown）照常经 aiChat/memoryMirror.ts 的 requestAiMemoryDelete 同步摘除，因此
 * 恢复时投出去的内容与 Disk I/O 的权威状态一致。
 */

import { isAiChatConfigured } from "./availability";
import { requestAiMemoryDelete } from "./memoryMirror";
import { postAiChatOrThrow, startAiChatWorker, syncAiChatConfig } from "./workerBridge";
import { activeStickerCatalogs } from "./stickerMirror";
import {
  aiChatBotInfo,
  aiMemoryRevisionCounters,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
} from "../cache/main/aiChat";
import { logger } from "../infra/logger";
import { getChatState } from "../infra/storage/stateStore";
import type { AiBotInfo } from "../types/aiChat/protocol";

/**
 * 按镜像把 AI 记忆投给已启动的 Worker：未开启 AI 或已不受管的群安排 durable 删除，
 * 其余群一次 hydrate。判据只看群开关，不看配置可用性（见 aiChat/availability.ts）。
 */
function postMirroredAiMemories(): void {
  const enabledMemories: Map<number, string> = new Map();
  const dropped: number[] = [];
  for (const [chatId, snapshot] of latestAiMemories) {
    if (getChatState(chatId).isAIChatEnabled === true) enabledMemories.set(chatId, snapshot);
    else dropped.push(chatId);
  }
  // 删除会改写镜像，放在遍历结束之后。
  for (const chatId of dropped) requestAiMemoryDelete(chatId, false);
  if (dropped.length > 0) {
    logger.log(`Dropping the persisted AI memory of ${dropped.length} chat(s) with AI chat disabled: ${dropped.join(", ")}.`);
  }
  if (enabledMemories.size > 0) {
    postAiChatOrThrow({ type: "hydrate", memories: enabledMemories });
  }
}

/** 按镜像把贴纸目录投给已启动的 Worker，让 ensureStickerCatalogs 的 diff 看到已恢复条目。 */
function postMirroredStickerCatalogs(): void {
  if (latestStickerCatalogs.size > 0) {
    postAiChatOrThrow({ type: "hydrateStickerCatalog", catalogs: activeStickerCatalogs() });
  }
}

/**
 * 启动时把 diskIOWorker 落盘恢复出的 AI 记忆快照写进镜像，AI 前提可用时再投给
 * Worker。必须在 initAiChat 之后、runner 开始投喂更新之前调用（见 app/lifecycle.ts），
 * FIFO 保证 hydrate 消息先于一切 record/trigger 到达。
 */
export function hydrateAiMemory(memories: Map<number, string>): void {
  for (const [chatId, snapshot] of memories) {
    latestAiMemories.set(chatId, snapshot);
    latestAiMemoryRevisions.set(chatId, 0);
    aiMemoryRevisionCounters.set(chatId, 0);
  }
  if (isAiChatConfigured()) postMirroredAiMemories();
}

/**
 * 启动时把 diskIOWorker 落盘恢复出的白名单贴纸目录写进镜像，AI 前提可用时再投给
 * Worker；时序要求同 hydrateAiMemory，排在它之后。
 */
export function hydrateStickerCatalog(catalogs: Map<string, string>): void {
  for (const [pack, snapshot] of catalogs) {
    latestStickerCatalogs.set(pack, snapshot);
  }
  if (isAiChatConfigured()) postMirroredStickerCatalogs();
}

/**
 * config/dynamic/ 热重载让 AI 前提从不可用变为可用时调用（见 app/configReload.ts）。调用方
 * 在本函数正常返回之后才发布 readiness，因此投喂在此之前一直关闭；抛错时调用方
 * 保持不可用，下一次 config/dynamic/ 事件再试。
 *
 * - Worker 已在运行（启动时可用、之后前提缺失而闲置）：按主线程当前快照改写
 *   lastInitState 并投递完整 configReload。
 * - Worker 从未启动（启动时就不可用）：按启动恢复同一顺序投递 init、各群人设、
 *   记忆与贴纸目录镜像。
 */
export function resumeAiChat(): void {
  if (lastInitState.current !== null) {
    syncAiChatConfig({ aiAgent: true, mood: true, stickers: true });
    return;
  }
  const botInfo: AiBotInfo | null = aiChatBotInfo.current;
  if (botInfo === null) {
    throw new Error("AI chat cannot start before initAiChat recorded the bot identity.");
  }
  startAiChatWorker(botInfo);
  postMirroredAiMemories();
  postMirroredStickerCatalogs();
}
