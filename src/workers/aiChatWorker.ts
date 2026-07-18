import { ensureStickerCatalogs, flushDirtyStickerCatalogs, hydrateStickerCatalogs } from "../ai/stickerCatalog";
import { stickerConfig } from "../ai/stickerConfig";
import { startWeatherRefreshLoop } from "../ai/weather";
import { AI_SNAPSHOT_INTERVAL_MS, RATE_LIMIT_LONG_WINDOW_MS, RATE_LIMIT_NOTICE_COOLDOWN_MS } from "../consts/aiChat";
import { botInfoState, longTriggerTimes, rateLimitNoticeTimes } from "../cache/aiChatWorker";
import { flushDirtyMemories, hydrateMemories, purgeChatMemory, recordChatMessage } from "./aiChat/rollingMemory";
import { recordChatMedia } from "./aiChat/mediaIngest";
import { generateAndSendReply, invalidateChatReplies } from "./aiChat/replyPipeline";
import type { AiChatWorkerMessage, AiMemoryFlushedEvent, AiStickerCatalogEvent } from "../types";

/**
 * AI 闲聊流水线线程（Bun Worker）。主线程（src/auto/message.ts → aiChat.ts 代理）
 * 只做事件投递，重活分散在 aiChat/ 目录下的内聚模块里：滚动对话缓存与快照
 * 落盘/恢复（aiChat/rollingMemory.ts）、中期记忆轮换压缩（aiChat/compaction.ts）、
 * 图片/贴纸/GIF 占位与异步描述回填（aiChat/mediaIngest.ts）、对话上下文拼装
 * （aiChat/promptContext.ts）、调 Gemini（含 function calling 往返与内置
 * googleSearch，aiChat/geminiReply.ts）、以及回复准入控制（并发闸 + 5 分钟
 * 滑动窗口限频 + 溢出排队补跑，aiChat/replyPipeline.ts）。发言/消息反应/
 * 应景贴纸全部工具化（send_message / add_reaction / view_sticker_pack +
 * send_sticker，见 ai/tools/replyToolset.ts）：模型在同一次对话里自主决定
 * 做哪几样、什么顺序。发往 Telegram 的调用不回主线程绕路——本线程 import
 * telegram.ts 时会得到自己独立的 grammY Api 客户端（那个 Bot 实例只用其
 * bot.api 发请求，从不 init/轮询；机器人自己的账号身份改由主线程在
 * bot.init() 后经 init 消息注入，见 cache/aiChatWorker.ts 的 botInfoState）。
 * error 日志经 logger.ts 的转发模式回传主线程统一落盘。本文件只剩消息路由、
 * 定时 sweep 与启动编排。
 *
 * 中期记忆：镜像/热块轮换机制见 consts/aiChat.ts 的 COMPACT_BATCH_SIZE 注释；
 * 轮换本身由 aiChat/rollingMemory.ts 的 pushBufferedMessage 触发、
 * aiChat/compaction.ts 的 scheduleRotation/rotateCompaction 实现。
 *
 * 贴纸目录：白名单贴纸包（机器人自己要发的那些）的画面描述目录由
 * ai/stickerCatalog.ts 生成/持久化，init 消息到达时后台启动生成（见
 * ensureStickerCatalogs），与本文件的 dirty 记忆快照共用同一条上报/落盘
 * 节奏（见文件底部的 setInterval 与 flushMemory 分支）。
 *
 * 心情系统：各群冷场太久（几小时量级）再冒泡时，随机换一种心情叠加进
 * 系统提示词，模拟真人聊天号状态会变的感觉，重抽时还按当前东京天气/
 * 时段微调各心情的概率，见 ai/mood.ts；两个内存缓存（cache/aiChatWorker.ts
 * 的 chatMoods/chatLastActivityTimes）都不落盘，随 Worker 重启清空。天气
 * 数据由 ai/weather.ts 统一维护并每小时自动刷新（见文件底部的
 * startWeatherRefreshLoop 调用），get_tokyo_weather 工具与心情系统都只
 * 读现有缓存、不各自发请求。
 */

declare var self: Worker;

self.onmessage = (event: MessageEvent<AiChatWorkerMessage>) => {
  const msg: AiChatWorkerMessage = event.data;
  switch (msg.type) {
    case "init":
      botInfoState.current = msg.botInfo;
      // 白名单贴纸包的目录生成后台启动，不阻塞后续 record/trigger 的处理，
      // 见 ai/stickerCatalog.ts 的 ensureStickerCatalogs；下一条 FIFO 消息
      // （若有）通常是 hydrateStickerCatalog，异步生成天然会先看到已恢复
      // 的条目再继续 diff（见该函数注释）。
      ensureStickerCatalogs(stickerConfig.packs);
      break;
    case "record":
      recordChatMessage(msg.chatId, msg.senderId, msg.firstName, msg.lastName, msg.username, msg.text);
      break;
    case "recordMedia":
      recordChatMedia(msg);
      break;
    case "trigger":
      generateAndSendReply(msg.chatId, msg.replyToMessageId, msg.repliedBotText, msg.isRandomTrigger);
      break;
    case "hydrate":
      hydrateMemories(msg.memories);
      break;
    case "hydrateStickerCatalog":
      hydrateStickerCatalogs(msg.catalogs);
      break;
    case "flushMemory":
      flushDirtyMemories();
      flushDirtyStickerCatalogs((event: AiStickerCatalogEvent) => self.postMessage(event));
      self.postMessage({ type: "memoryFlushed", flushId: msg.flushId } satisfies AiMemoryFlushedEvent);
      break;
    case "invalidateChat":
      invalidateChatReplies(msg.chatId);
      if (msg.purgeMemory) {
        purgeChatMemory(msg.chatId);
        self.postMessage({ type: "memoryDeleted", chatId: msg.chatId });
      }
      break;
  }
};

// dirty 群的记忆快照 + dirty 的贴纸目录定时上报给主线程（进而落盘），见
// consts/aiChat.ts 的 AI_SNAPSHOT_INTERVAL_MS 注释。Worker 线程活到进程
// 退出为止，不需要引用计数/按需启停，无条目时两个 flush 都直接空转返回。
setInterval(() => {
  const now: number = Date.now();
  for (const [chatId, times] of longTriggerTimes) {
    while (times.size > 0 && now - times.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) times.shift();
    if (times.size === 0) longTriggerTimes.delete(chatId);
  }
  for (const [chatId, at] of rateLimitNoticeTimes) {
    if (now - at >= RATE_LIMIT_NOTICE_COOLDOWN_MS) rateLimitNoticeTimes.delete(chatId);
  }
  flushDirtyMemories();
  flushDirtyStickerCatalogs((event: AiStickerCatalogEvent) => self.postMessage(event));
}, AI_SNAPSHOT_INTERVAL_MS);

// 东京天气的后台定时刷新（见 ai/weather.ts）：get_tokyo_weather 工具与
// 心情系统（ai/mood.ts）共用这一份缓存，全进程只在这里发起，二者都只
// 读不发请求。全进程只应调用一次——重复调用会叠加出多个定时器。
startWeatherRefreshLoop();
