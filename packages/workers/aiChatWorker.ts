import {
  drainStickerCatalogTasks,
  ensureStickerCatalogs,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
  pruneStickerCatalogs,
  retryIncompleteStickerCatalogs,
} from "../aiChat/ai/stickers/catalog";
import { installAiCacheUsageSink } from "../infra/aiCacheUsage";
import type { AiCacheUsage } from "../types/aiCache";
import { adoptStickerConfig, getStickerConfig } from "../config/stickers";
import { adoptMoodConfig } from "../config/mood";
import { adoptPersona } from "../config/persona";
import { adoptAgentDeploymentConfig } from "../config/agent";
import { reportUnimplementedAgentCapabilities } from "../aiChat/provider";
import { startWeatherRefreshLoop, stopWeatherRefreshLoop } from "../aiChat/ai/weather";
import { AI_SNAPSHOT_INTERVAL_MS } from "../consts/aiChat/memory";
import { botInfoState, superAdminUserIdState, atmosphereState } from "../cache/workers/aiChat/identity";
import { adoptTimeZone } from "../config/time";
import { TOKYO_TIME_ZONE } from "../consts/time";
import { sweepImageGenerationCache } from "../cache/workers/aiChat/imageGeneration";
import { sweepGeminiReplyRequestTimes } from "../cache/workers/aiChat/geminiContextCache";
import { clearChatMemoryCache } from "../cache/workers/aiChat/memory";
import { sweepAiChatReplyCache } from "../cache/workers/aiChat/replies";
import { voiceToolPromptCache } from "../cache/perThread/config";
import {
  aiChatMaintenanceTimer,
  aiChatWorkerAbortController,
  aiChatWorkerDrain,
  aiChatWorkerQuiescing,
} from "../cache/workers/aiChat/worker";
import {
  flushDirtyMemories,
  flushMemorySnapshot,
  hydrateMemories,
  recordChatMessage,
} from "./aiChat/rollingMemory";
import { recordChatMedia } from "./aiChat/mediaIngest";
import { handleCancelVoiceSynthesis, handleSynthesizeVoice } from "./aiChat/voiceSynthesis";
import { handleCancelWebDigest, handleComposeWebDigest } from "./aiChat/webDigest";
import { hydrateTtsUsage } from "../aiChat/ai/ttsUsage";
import { recordBotImage, resolveRepliedBotImage } from "./aiChat/botImages";
import type { BufferedMessage } from "../types/aiChat/memory";
import { applyAiChatConfigReload } from "./aiChat/configReload";
import {
  drainPendingReplyQueues,
  generateAndSendReply,
} from "./aiChat/replyPipeline";
import { invalidateChatReplies, quiesceAiChatReplies } from "./aiChat/replyGeneration";
import { currentMood, switchMood } from "../aiChat/ai/mood";
import type {
  AiCacheUsageEvent,
  AiChatInvalidatedEvent,
  AiChatWorkerMessage,
  AiInvalidateChatMessage,
  AiMemoryDeletedEvent,
  AiMemoryFlushedEvent,
  AiMoodQueriedEvent,
  AiMoodSwitchedEvent,
  RepliedBotImage,
} from "../types/aiChat/protocol";
import type { AiStickerCatalogEvent } from "../types/stickers/protocol";
import { resetWorkerDuplex } from "../libs/workerDuplex";
import type { TelegramWorkerRequest } from "../types/telegramWorker";
import { logger } from "../infra/logger";
import { installBusinessWorkerPort } from "./businessWorkerPort";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（packages/auto/message/ → aiChat/index.ts 代理）
 * 只做事件投递，重活分散在 workers/aiChat/ 目录下的内聚模块里：滚动对话缓存与快照
 * 落盘/恢复（aiChat/rollingMemory.ts）、中期记忆轮换压缩（aiChat/compaction.ts）、
 * 图片/贴纸/GIF 占位与异步描述回填（aiChat/mediaIngest.ts）、对话上下文拼装
 * （aiChat/promptContext.ts）、调模型（含 function calling 往返与内置
 * 服务端联网检索，aiChat/replyModel.ts）、以及回复准入控制（并发闸、
 * 滑动窗口限频与溢出排队补跑，aiChat/replyPipeline.ts）。发言、消息反应、
 * 应景贴纸与重媒体创作全部工具化（send_message / add_reaction /
 * view_sticker_pack + send_sticker / generate_image / send_voice，见
 * aiChat/ai/tools/replyToolset/）；生图与语音按部署能力挂载，由模型按工具
 * 说明决定是否调用及组合顺序。主线程的 `/send` 代发 TTS 与 cron
 * `send_voice` 经 synthesizeVoice 请求借用同一套合成实现（aiChat/voiceSynthesis.ts），cron
 * `send_web_digest` 经 composeWebDigest 请求在这里检索并组稿（aiChat/webDigest.ts）。
 * 发往 Telegram 的调用统一经双工能力请求回到主线程，Worker 不持有独立 Telegram 网络客户端；
 * 机器人自己的账号身份由主线程在 bot.init() 后经 init 消息注入，见
 * cache/workers/aiChat/identity.ts 的 botInfoState。error 日志经 logger.ts 的转发模式回传
 * 主线程统一落盘。本文件做消息路由、定时 sweep 与启动编排。
 *
 * 中期记忆：镜像/热块轮换机制见 consts/aiChat/memory.ts 的 COMPACT_BATCH_SIZE 注释；
 * 轮换由 aiChat/rollingMemory.ts 的 pushBufferedMessage 触发，
 * aiChat/compaction.ts 的 scheduleRotation/rotateCompaction 实现。
 *
 * 贴纸目录：白名单贴纸包的画面描述目录由 aiChat/ai/stickers/catalog.ts 生成/持久化，
 * init 消息到达时后台启动生成（见 ensureStickerCatalogs），与 dirty 记忆快照共用同一条
 * 上报/落盘节奏（见 runAiChatWorkerMaintenance 与 flushMemory 分支）。
 *
 * 心情系统：全 Worker 只有一份心情、所有群共用，随机寿命到期后下次任一群拼运行时状态区块时
 * 重抽，与群是否活跃无关；重抽时按当前东京天气（仅配置时区为东京时有）与配置时区时段
 * 微调各心情的概率，见 aiChat/ai/mood.ts。当前心情与到期时刻（cache/workers/aiChat/mood.ts 的
 * currentMoodState）不落盘，随 Worker 重启清空。天气数据由 aiChat/ai/weather.ts 统一维护，
 * 配置时区为东京时按固定间隔自动刷新（见 init 分支的 startWeatherRefreshLoop 调用），
 * get_tokyo_weather 工具与心情系统都只读现有缓存、不各自发请求。
 */

declare const self: Worker;

function handleInvalidateChat(msg: AiInvalidateChatMessage): void {
  // invalidateChatReplies 在返回 Promise 前已同步撤销旧 epoch 并 abort 旧代；
  // 记忆清理同样同步发生，先于后续 FIFO record。
  const drained: Promise<void> = invalidateChatReplies(msg.chatId);
  clearChatMemoryCache(msg.chatId);
  self.postMessage({ type: "memoryDeleted", chatId: msg.chatId } satisfies AiMemoryDeletedEvent);
  void drained.then((): void => {
    self.postMessage({
      type: "chatInvalidated",
      chatId: msg.chatId,
      requestId: msg.requestId,
    } satisfies AiChatInvalidatedEvent);
  });
}

/** 首条 flush 同步封住新任务入口，并停止会派生目录/回复工作的后台推力。 */
function beginAiChatWorkerQuiesce(): Promise<void> {
  aiChatWorkerQuiescing.current = true;
  aiChatWorkerAbortController.current.abort(
    new DOMException("AI chat Worker is quiescing.", "AbortError")
  );
  if (aiChatMaintenanceTimer.current !== null) {
    clearInterval(aiChatMaintenanceTimer.current);
    aiChatMaintenanceTimer.current = null;
  }
  stopWeatherRefreshLoop();
  aiChatWorkerDrain.current ??= Promise.allSettled([
    quiesceAiChatReplies(),
    drainStickerCatalogTasks(),
  ]).then((settlements: PromiseSettledResult<void>[]): void => {
    const labels: readonly string[] = ["reply generation", "sticker catalog"];
    const failures: Error[] = [];
    for (let index: number = 0; index < settlements.length; index++) {
      const settlement: PromiseSettledResult<void> = settlements[index]!;
      if (settlement.status === "rejected") {
        failures.push(new Error(`AI Worker ${labels[index]} drain rejected.`, {
          cause: settlement.reason,
        }));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "AI Worker drain phases rejected.");
    }
  });
  return aiChatWorkerDrain.current;
}

/** 排空所有会改写记忆/目录的任务后才上报最终快照并确认 flush。 */
async function flushAiChatWorker(flushId: number): Promise<void> {
  await beginAiChatWorkerQuiesce();
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => self.postMessage(event));
  self.postMessage({ type: "memoryFlushed", flushId } satisfies AiMemoryFlushedEvent);
}

/** 路由一条主线程消息；独立导出便于验证协议而不启动真实 Worker。 */
export function handleAiChatWorkerMessage(msg: AiChatWorkerMessage): void {
  switch (msg.type) {
    case "init":
      adoptTimeZone(msg.timeZone);
      // 东京天气的后台定时刷新（见 aiChat/ai/weather.ts）：get_tokyo_weather 工具与
      // 心情系统（aiChat/ai/mood.ts）共用这一份缓存，全进程只在这里发起。只有启动时区为
      // 东京时才刷新，其它时区的心情没有天气加权。重复启动不叠加定时器，停止时取消在途请求。
      if (msg.timeZone === TOKYO_TIME_ZONE) startWeatherRefreshLoop();
      // 配置先于任何会调模型的动作落定，ensureStickerCatalogs 随后读取 media 能力的模型名与凭据。
      // 本线程不读 agent.json，运行期变化只经 configReload 消息到达，崩溃重建时主线程重放
      // 带着当前快照的 init（见 config/agent.ts 的边界说明）。
      adoptAgentDeploymentConfig(msg.agent);
      adoptMoodConfig(msg.mood);
      adoptStickerConfig(msg.stickers);
      adoptPersona(msg.persona);
      voiceToolPromptCache.current = msg.voiceToolPrompt;
      // 配置落定后把「配了但这一家没实现」的可选能力记一次；热重载替换
      // agent 段时由 reloadAgentDeploymentConfig 再记一次，逐轮回复不重复记录。
      reportUnimplementedAgentCapabilities();
      botInfoState.current = msg.botInfo;
      superAdminUserIdState.current = msg.superAdminUserId;
      atmosphereState.current = msg.atmosphere;
      // 白名单贴纸包的目录生成后台启动，不阻塞后续 record/trigger 的处理，
      // 见 aiChat/ai/stickers/catalog.ts 的 ensureStickerCatalogs；已恢复的目录由随后到达的
      // hydrateStickerCatalog 消息灌入（见 hydrateStickerCatalogs）。
      ensureStickerCatalogs(getStickerConfig().packs);
      break;
    case "configReload":
      applyAiChatConfigReload(msg);
      break;
    case "record": {
      if (aiChatWorkerQuiescing.current) break;
      const entry: BufferedMessage | null = recordChatMessage(msg);
      const botImage: RepliedBotImage | undefined = msg.replyTo?.botImage;
      if (entry !== null && botImage !== undefined) resolveRepliedBotImage(msg.chatId, entry, botImage);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    }
    case "recordMedia":
      if (aiChatWorkerQuiescing.current) break;
      recordChatMedia(msg);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    case "recordBotImage":
      if (aiChatWorkerQuiescing.current) break;
      recordBotImage(msg);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    case "trigger":
      if (aiChatWorkerQuiescing.current) break;
      generateAndSendReply(msg);
      break;
    case "hydrate":
      hydrateMemories(msg.memories);
      break;
    case "hydrateStickerCatalog":
      hydrateStickerCatalogs(msg.catalogs);
      break;
    case "flushMemory":
      void flushAiChatWorker(msg.flushId).catch((error: unknown): void => {
        logger.error(`AI Worker flush ${msg.flushId} rejected before acknowledgement:`, error);
      });
      break;
    case "invalidateChat":
      handleInvalidateChat(msg);
      break;
    case "queryMood":
      if (Date.now() >= msg.deadlineAt) break;
      // /mood query 只读取当前有效档位，自然到期由 currentMood 处理，不强制重抽。
      self.postMessage({
        type: "moodQueried",
        requestId: msg.requestId,
        moodName: currentMood().name,
      } satisfies AiMoodQueriedEvent);
      break;
    case "switchMood":
      // 副作用发生前检查绝对截止时刻，积压到过期的命令不改心情。
      if (Date.now() >= msg.deadlineAt) break;
      // /mood switch：同步重抽后立刻回执结果；回复由主线程命令处理器发出，
      // 本线程不发 Telegram 消息（见 commands/mood.ts）。
      self.postMessage({
        type: "moodSwitched",
        requestId: msg.requestId,
        moodName: switchMood().name,
      } satisfies AiMoodSwitchedEvent);
      break;
    case "synthesizeVoice":
      handleSynthesizeVoice(msg);
      break;
    case "cancelVoiceSynthesis":
      handleCancelVoiceSynthesis(msg);
      break;
    case "composeWebDigest":
      handleComposeWebDigest(msg);
      break;
    case "cancelWebDigest":
      handleCancelWebDigest(msg);
      break;
    case "hydrateTtsUsage":
      hydrateTtsUsage(msg.usage);
      break;
  }
}

/**
 * 维护节拍：清理各缓存的过期条目，补跑积压的触发，并把 dirty 群的记忆快照与 dirty 的
 * 贴纸目录上报给主线程（进而落盘），节拍间隔见 consts/aiChat/memory.ts 的
 * AI_SNAPSHOT_INTERVAL_MS。无条目时两个 flush 直接返回。
 */
export function runAiChatWorkerMaintenance(now: number = Date.now()): void {
  if (aiChatWorkerQuiescing.current) return;
  sweepAiChatReplyCache(now);
  // 限频窗口空出后补跑积压的直接触发：这类触发没有开始过的轮次，不会有 onFinished
  // 推动队列（见 aiChat/replyPipeline.ts）。
  drainPendingReplyQueues(now);
  sweepImageGenerationCache(now);
  // 触发时刻按单调时钟记录，清扫同取 performance.now()。
  sweepGeminiReplyRequestTimes(performance.now());
  // 配置轮换、任务结算与上报均会清理旧包；维护节拍复核仍在途或待上报的条目。
  pruneStickerCatalogs(getStickerConfig().packs);
  // 启动对账中整包失败的贴纸包在这里重试。
  retryIncompleteStickerCatalogs(getStickerConfig().packs, now);
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => self.postMessage(event));
}

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler、计时器或网络刷新。 */
export function startAiChatWorker(): void {
  if (aiChatMaintenanceTimer.current !== null) return;
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  aiChatWorkerDrain.current = null;
  installBusinessWorkerPort<TelegramWorkerRequest, AiChatWorkerMessage>(handleAiChatWorkerMessage);
  installAiCacheUsageSink((usage: AiCacheUsage): void => {
    self.postMessage({ type: "aiCacheUsage", usage } satisfies AiCacheUsageEvent);
  });
  aiChatMaintenanceTimer.current = setInterval(runAiChatWorkerMaintenance, AI_SNAPSHOT_INTERVAL_MS);
  aiChatMaintenanceTimer.current.unref();
  process.once("exit", stopAiChatWorker);
}

/** 协作式停止 AI Worker 的 handler、维护 timer 与天气刷新 owner。 */
export function stopAiChatWorker(): void {
  aiChatWorkerAbortController.current.abort(
    new DOMException("AI chat Worker stopped.", "AbortError")
  );
  if (aiChatMaintenanceTimer.current !== null) {
    clearInterval(aiChatMaintenanceTimer.current);
    aiChatMaintenanceTimer.current = null;
  }
  stopWeatherRefreshLoop();
  installAiCacheUsageSink(null);
  resetWorkerDuplex("AI Worker stopped before the main-thread request completed.");
  self.onmessage = null;
  process.off("exit", stopAiChatWorker);
}

if (!Bun.isMainThread) startAiChatWorker();
