import {
  ensureStickerCatalogs,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
  retryIncompleteStickerCatalogs,
} from "../aiChat/ai/stickers/catalog";
import { getStickerConfig } from "../config/stickers";
import { startWeatherRefreshLoop, stopWeatherRefreshLoop } from "../aiChat/ai/weather";
import { AI_SNAPSHOT_INTERVAL_MS } from "../consts/aiChat/memory";
import { botInfoState } from "../cache/workers/aiChat/identity";
import { sweepImageGenerationCache } from "../cache/workers/aiChat/imageGeneration";
import { sweepAiChatReplyCache } from "../cache/workers/aiChat/replies";
import { aiChatMaintenanceTimer } from "../cache/workers/aiChat/worker";
import {
  flushDirtyMemories,
  flushMemorySnapshot,
  hydrateMemories,
  purgeChatMemory,
  recordChatMessage,
} from "./aiChat/rollingMemory";
import { recordChatMedia } from "./aiChat/mediaIngest";
import { drainPendingReplyQueues, generateAndSendReply, invalidateChatReplies } from "./aiChat/replyPipeline";
import { switchMood } from "../aiChat/ai/mood";
import type {
  AiChatInvalidatedEvent,
  AiChatWorkerMessage,
  AiInvalidateChatMessage,
  AiMemoryFlushedEvent,
  AiMoodSwitchedEvent,
} from "../types/aiChat/protocol";
import type { AiStickerCatalogEvent } from "../types/stickers/protocol";
import { initTelegramClients } from "../infra/telegram";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（packages/auto/message/ → aiChat/index.ts 代理）
 * 只做事件投递，重活分散在 aiChat/ 目录下的内聚模块里：滚动对话缓存与快照
 * 落盘/恢复（aiChat/rollingMemory.ts）、中期记忆轮换压缩（aiChat/compaction.ts）、
 * 图片/贴纸/GIF 占位与异步描述回填（aiChat/mediaIngest.ts）、对话上下文拼装
 * （aiChat/promptContext.ts）、调 Gemini（含 function calling 往返与内置
 * googleSearch，aiChat/geminiReply.ts）、以及回复准入控制（并发闸 + 5 分钟
 * 滑动窗口限频 + 溢出排队补跑，aiChat/replyPipeline.ts）。发言/消息反应/
 * 应景贴纸与生图全部工具化（send_message / add_reaction / view_sticker_pack +
 * send_sticker / generate_image，见 aiChat/ai/tools/replyToolset/）：模型在同一次对话里自主决定
 * 做哪几样、什么顺序。发往 Telegram 的调用不回主线程绕路——本线程 import
 * infra/telegram/ 时会得到自己独立的 grammY Api 客户端（那个 Bot 实例只用其
 * bot.api 发请求，从不 init/轮询；机器人自己的账号身份改由主线程在
 * bot.init() 后经 init 消息注入，见 cache/workers/aiChat/identity.ts 的 botInfoState）。
 * error 日志经 logger.ts 的转发模式回传主线程统一落盘。本文件只剩消息路由、
 * 定时 sweep 与启动编排。
 *
 * 中期记忆：镜像/热块轮换机制见 consts/aiChat/memory.ts 的 COMPACT_BATCH_SIZE 注释；
 * 轮换本身由 aiChat/rollingMemory.ts 的 pushBufferedMessage 触发、
 * aiChat/compaction.ts 的 scheduleRotation/rotateCompaction 实现。
 *
 * 贴纸目录：白名单贴纸包（机器人自己要发的那些）的画面描述目录由
 * aiChat/ai/stickers/catalog.ts 生成/持久化，init 消息到达时后台启动生成（见
 * ensureStickerCatalogs），与本文件的 dirty 记忆快照共用同一条上报/落盘
 * 节奏（见文件底部的 setInterval 与 flushMemory 分支）。
 *
 * 心情系统：各群心情按随机寿命（几小时量级）自然到期轮换，到期后下次
 * 拼系统提示词时重抽叠加进去，与群是否活跃无关，模拟真人聊天号状态会变
 * 的感觉；重抽时还按当前东京天气/时段微调各心情的概率，见 aiChat/ai/mood.ts；
 * 两个内存缓存（cache/workers/aiChat/mood.ts
 * 的 chatMoods/chatMoodExpiresAts）都不落盘，随 Worker 重启清空。天气
 * 数据由 aiChat/ai/weather.ts 统一维护并每小时自动刷新（见文件底部的
 * startWeatherRefreshLoop 调用），get_tokyo_weather 工具与心情系统都只
 * 读现有缓存、不各自发请求。
 */

declare const self: Worker;

function handleInvalidateChat(msg: AiInvalidateChatMessage): void {
  // invalidateChatReplies 在返回 Promise 前已同步撤销旧 epoch 并 abort 旧代；
  // purge 同样必须同步发生，避免随后 FIFO record 被迟到的清理删掉。
  const drained: Promise<void> = invalidateChatReplies(msg.chatId);
  if (msg.purgeMemory) {
    purgeChatMemory(msg.chatId);
    self.postMessage({ type: "memoryDeleted", chatId: msg.chatId });
  }
  void drained.then((): void => {
    self.postMessage({
      type: "chatInvalidated",
      chatId: msg.chatId,
      requestId: msg.requestId,
    } satisfies AiChatInvalidatedEvent);
  });
}

/** 路由一条主线程消息；独立导出便于验证协议而不启动真实 Worker。 */
export function handleAiChatWorkerMessage(msg: AiChatWorkerMessage): void {
  switch (msg.type) {
    case "init":
      botInfoState.current = msg.botInfo;
      // 白名单贴纸包的目录生成后台启动，不阻塞后续 record/trigger 的处理，
      // 见 aiChat/ai/stickers/catalog.ts 的 ensureStickerCatalogs；下一条 FIFO 消息
      // （若有）通常是 hydrateStickerCatalog，异步生成天然会先看到已恢复
      // 的条目再继续 diff（见该函数注释）。
      ensureStickerCatalogs(getStickerConfig().packs);
      break;
    case "record":
      recordChatMessage(msg);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    case "recordMedia":
      recordChatMedia(msg);
      if (msg.persistImmediately === true) flushMemorySnapshot(msg.chatId, true);
      break;
    case "trigger":
      generateAndSendReply(msg);
      break;
    case "hydrate":
      hydrateMemories(msg.memories);
      break;
    case "hydrateStickerCatalog":
      hydrateStickerCatalogs(msg.catalogs);
      break;
    case "flushMemory":
      flushDirtyMemories();
      flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => self.postMessage(event));
      self.postMessage({ type: "memoryFlushed", flushId: msg.flushId } satisfies AiMemoryFlushedEvent);
      break;
    case "invalidateChat":
      handleInvalidateChat(msg);
      break;
    case "switchMood":
      // 主线程超时只会撤销 waiter，无法从 Worker 消息队列里召回已投递请求；
      // 因此在副作用发生前检查绝对截止时刻，积压到过期的命令不得迟到改心情。
      if (Date.now() >= msg.deadlineAt) break;
      // /switch_mood：同步重抽后立刻回执结果；回复由主线程命令处理器发出，
      // 本线程不发 Telegram 消息（见 commands/switchMood.ts）。
      self.postMessage({
        type: "moodSwitched",
        chatId: msg.chatId,
        requestId: msg.requestId,
        moodName: switchMood(msg.chatId).name,
      } satisfies AiMoodSwitchedEvent);
      break;
  }
}

// dirty 群的记忆快照 + dirty 的贴纸目录定时上报给主线程（进而落盘），见
// consts/aiChat.ts 的 AI_SNAPSHOT_INTERVAL_MS 注释。Worker 线程活到进程
// 退出为止，不需要引用计数/按需启停，无条目时两个 flush 都直接空转返回。
export function runAiChatWorkerMaintenance(now: number = Date.now()): void {
  sweepAiChatReplyCache(now);
  // 限频窗口一空出来就把积压的直接触发补跑掉：那条路上的轮次从没开始过，
  // 没有 onFinished 会来推队列（见 aiChat/replyPipeline.ts）。
  drainPendingReplyQueues(now);
  sweepImageGenerationCache(now);
  // 启动那次对账整包失败的（拉贴纸集合时网络抖了一下）在这里补回来：
  // 没有它，一次瞬时失败就等于两个贴纸工具在整个进程生命周期里失效。
  retryIncompleteStickerCatalogs(getStickerConfig().packs, now);
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => self.postMessage(event));
}

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler、计时器或网络刷新。 */
export function startAiChatWorker(): void {
  if (aiChatMaintenanceTimer.current !== null) return;
  initTelegramClients();
  self.onmessage = (event: MessageEvent<AiChatWorkerMessage>): void => {
    handleAiChatWorkerMessage(event.data);
  };
  aiChatMaintenanceTimer.current = setInterval(runAiChatWorkerMaintenance, AI_SNAPSHOT_INTERVAL_MS);
  aiChatMaintenanceTimer.current.unref();
  // 东京天气的后台定时刷新（见 aiChat/ai/weather.ts）：get_tokyo_weather 工具与
  // 心情系统（aiChat/ai/mood.ts）共用这一份缓存，全进程只在这里发起，二者都只
  // 读不发请求。全进程只应调用一次——重复调用会叠加出多个定时器。
  startWeatherRefreshLoop();
  process.once("exit", stopAiChatWorker);
}

/** 协作式停止 AI Worker 的 handler、维护 timer 与天气刷新 owner。 */
export function stopAiChatWorker(): void {
  if (aiChatMaintenanceTimer.current !== null) {
    clearInterval(aiChatMaintenanceTimer.current);
    aiChatMaintenanceTimer.current = null;
  }
  stopWeatherRefreshLoop();
  self.onmessage = null;
  process.off("exit", stopAiChatWorker);
}

if (!Bun.isMainThread) startAiChatWorker();
