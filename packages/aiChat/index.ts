import { superviseWorker } from "../libs/supervisedWorker";
import { markSelfSent } from "../infra/selfSentTracker";
import { registerChatTeardown } from "../infra/chatTeardown";
import { logger } from "../infra/logger";
import { postDiskIO } from "../ai/persistence";
import { nextAiMemoryRevision, requestAiMemoryDelete } from "./memoryMirror";
import {
  aiChatWorkerState,
  aiMemoryFlushBarrier,
  aiMemoryRevisionCounters,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  moodSwitchRequestCounter,
  moodSwitchWaiters,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
  type MoodSwitchWaiter,
} from "../cache/aiChat";
import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import { MOOD_SWITCH_TIMEOUT_MS } from "../consts/aiChat/mood";
import type { FlushResult } from "../types/lifecycle";
import { getChatState } from "../infra/storage/stateStore";
import type {
  AiBotInfo,
  AiChatWorkerEvent,
  AiChatWorkerMessage,
  AiInitMessage,
  AiRecordMediaMessage,
  AiRecordMessage,
  AiTriggerMessage,
} from "../types/aiChat/protocol";

/** 在途 switchMood 请求统一失败结算：Worker 崩溃重启/放弃/终止时，旧实例
 *  的回执不可能再到达，不结算会让命令处理器干等到超时。 */
function rejectAllMoodSwitchWaiters(reason: string): void {
  for (const waiter of moodSwitchWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  moodSwitchWaiters.clear();
}

/**
 * AI 闲聊入口（主线程侧代理）。真正的回复流水线——滚动对话缓存、图片/
 * 贴纸/GIF 占位与异步描述、限频、拼装上下文、调 Gemini（含 function
 * calling 往返与内置 googleSearch）、工具化的发言/消息反应/两层应景贴纸
 * （见 packages/ai/tools/replyToolset/）、白名单贴纸目录与整包简介生成——全部在独立
 * 的 Bun Worker（packages/workers/aiChatWorker.ts）里
 * 执行；主线程只把「记录一条群消息/媒体」「触发一次回复」两类事件投递过去，
 * 让 /命令 处理与更新调度不被 AI 流水线抢占。postMessage 按 FIFO 送达，
 * 同一群里「先记录、后触发」的先后顺序在 Worker 侧保持不变。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 libs/supervisedWorker.ts。
 *
 * AI 记忆持久化：aiChatWorker 定期把各群 dirty 的记忆快照（滚动缓存 + 中期
 * 摘要）、各白名单贴纸包 dirty 的目录快照上报到这里（memory / stickerCatalog
 * 事件），本模块各存一份镜像（latestAiMemories / latestStickerCatalogs）后
 * 转投 diskIOWorker 落盘。这份镜像与按 chat 单调递增的 revision、待确认删除
 * tombstone 一起构成双向崩溃重放来源：aiChatWorker 崩溃重启后凭镜像重放
 * hydrate（下方 onRespawn），diskIOWorker 崩溃重启后重放 tombstone 与最新快照。
 * revision / tombstone / 删除回执 waiter 与 diskIOWorker 侧的重放都在
 * aiChat/memoryMirror.ts；本文件只保留 Worker 监督与对外 API。
 */

const { init: initAiChatWorker, post, terminate: terminateAiChatWorker } = superviseWorker<AiChatWorkerMessage, AiChatWorkerEvent>({
  url: new URL("../workers/aiChatWorker.ts", import.meta.url).href,
  label: "AI Worker",
  giveUpConsequence: "AI chat feature will silently stay disabled until the process restarts.",
  onEvent: (event) => {
    switch (event.type) {
      case "sent":
        // Worker 报回它刚发出的消息：登记进自发消息表，供自动流水线识别
        // 频道自回环（见 infra/selfSentTracker.ts）。
        markSelfSent(event.chatId, event.messageId);
        break;
      case "memory":
        if (purgedAiMemoryChats.has(event.chatId)) {
          requestAiMemoryDelete(event.chatId, false);
          break;
        }
        {
          const revision: number = nextAiMemoryRevision(event.chatId);
          const persistImmediately: boolean =
            event.persistImmediately === true &&
            postPurgeAiMemoryPersistRevisions.has(event.chatId);
          if (persistImmediately) {
            postPurgeAiMemoryPersistRevisions.set(event.chatId, revision);
          }
          latestAiMemories.set(event.chatId, event.snapshot);
          latestAiMemoryRevisions.set(event.chatId, revision);
          postDiskIO({
            type: "aiMemory",
            chatId: event.chatId,
            revision,
            snapshot: event.snapshot,
            ...(persistImmediately ? { persistImmediately: true } : {}),
          });
        }
        break;
      case "memoryDeleted":
        purgedAiMemoryChats.delete(event.chatId);
        requestAiMemoryDelete(event.chatId, false);
        break;
      case "stickerCatalog":
        latestStickerCatalogs.set(event.pack, event.snapshot);
        postDiskIO({ type: "stickerCatalog", pack: event.pack, snapshot: event.snapshot });
        break;
      case "memoryFlushed": {
        aiMemoryFlushBarrier.settle(event.flushId, "flushed");
        break;
      }
      case "moodSwitched": {
        const waiter: MoodSwitchWaiter | undefined = moodSwitchWaiters.get(event.requestId);
        if (!waiter) break;
        moodSwitchWaiters.delete(event.requestId);
        clearTimeout(waiter.timer);
        waiter.resolve(event.moodName);
        break;
      }
    }
  },
  onRespawn: (postToNext) => {
    aiMemoryFlushBarrier.settleAll("failed");
    rejectAllMoodSwitchWaiters("AI Worker crashed before acknowledging the mood switch.");
    // 新 Worker 重新走一遍身份注入，FIFO 保证它先于任何 record/trigger 到达。
    // 重启发生在 initAiChat 调用之前的话 lastInitState.current 仍是 null，
    // 没有可重放的，新 Worker 等本来就该来的那次 initAiChat 调用即可。
    if (lastInitState.current && !postToNext(lastInitState.current)) return;
    // 记忆镜像同样要重放：新 Worker 内存全空，凭上一实例上报过的最新快照
    // 补齐（见模块头注）。
    if (latestAiMemories.size > 0) {
      if (!postToNext({ type: "hydrate", memories: latestAiMemories })) return;
    }
    // 贴纸目录镜像同理：新 Worker 的 init 处理会重新 ensureStickerCatalogs，
    // 若不先灌回已生成的条目会白白重新调一遍视觉模型。
    if (latestStickerCatalogs.size > 0) {
      if (!postToNext({ type: "hydrateStickerCatalog", catalogs: latestStickerCatalogs })) {
        logger.error("AI Worker sticker catalog replay was rejected.");
      }
    }
  },
  onGiveUp: () => {
    aiChatWorkerState.available = false;
    rejectAllMoodSwitchWaiters("AI Worker gave up restarting before acknowledging the mood switch.");
    // 已终止实例不可能再回传旧 memory；purged 只负责拒绝旧 Worker 快照。
    // pendingAiMemoryDeletes 由 Disk I/O durable 回执拥有，绝不能在这里清空。
    purgedAiMemoryChats.clear();
    // 尚未收到首份快照（null）的群已不可能由终止的 Worker 回传；已经投给
    // Disk I/O 的数字 revision 继续保留，供其重建时维持即时写盘语义。
    for (const [chatId, revision] of postPurgeAiMemoryPersistRevisions) {
      if (revision === null) postPurgeAiMemoryPersistRevisions.delete(chatId);
    }
  },
});

function postAiChatOrThrow(message: AiChatWorkerMessage): void {
  if (post(message)) return;
  aiChatWorkerState.available = false;
  throw new Error("AI Worker is unavailable.");
}

/**
 * 把机器人自己的账号身份注入 AI Worker。须在 bot.init() 之后、runner 开始
 * 投喂更新之前调用一次（见 app/lifecycle.ts）——FIFO 保证 init 消息先于一切
 * record/trigger 到达。Worker 靠它在转录里认出自己并自录自己发的消息。
 * 顺带记一份 lastInitState：Worker 崩溃重启后要重放这条消息，新 Worker 才能
 * 重新认出自己。
 */
export function initAiChat(botInfo: AiBotInfo): void {
  initAiChatWorker();
  const message: AiInitMessage = {
    type: "init",
    botInfo: { id: botInfo.id, username: botInfo.username, first_name: botInfo.first_name },
  };
  postAiChatOrThrow(message);
  lastInitState.current = message;
  aiChatWorkerState.available = true;
}

/**
 * 启动时把 diskIOWorker 落盘恢复出的 AI 记忆快照灌回来：先存一份镜像
 * （供后续崩溃重放，见模块头注），再投递给 Worker 做 hydrate。必须在
 * initAiChat 之后、runner 开始投喂更新之前调用（见 app/lifecycle.ts），FIFO 保证
 * hydrate 消息先于一切 record/trigger 到达。
 */
export function hydrateAiMemory(memories: Map<number, string>): void {
  const enabledMemories: Map<number, string> = new Map();
  for (const [chatId, snapshot] of memories) {
    if (getChatState(chatId).isAIChatEnabled !== true) {
      requestAiMemoryDelete(chatId, false);
      continue;
    }
    latestAiMemories.set(chatId, snapshot);
    latestAiMemoryRevisions.set(chatId, 0);
    aiMemoryRevisionCounters.set(chatId, 0);
    enabledMemories.set(chatId, snapshot);
  }
  if (enabledMemories.size > 0) {
    postAiChatOrThrow({ type: "hydrate", memories: enabledMemories });
  }
}

/**
 * 启动时把 diskIOWorker 落盘恢复出的白名单贴纸目录灌回来：先存一份镜像
 * （供后续崩溃重放，见模块头注），再投递给 Worker 做 hydrate。必须在
 * initAiChat 之后、runner 开始投喂更新之前调用（见 app/lifecycle.ts）——FIFO 保证
 * 这条消息紧跟在 init 之后，让 ensureStickerCatalogs 的 diff 生成看到已
 * 恢复的条目、不重复调视觉模型。
 */
export function hydrateStickerCatalog(catalogs: Map<string, string>): void {
  for (const [pack, snapshot] of catalogs) {
    latestStickerCatalogs.set(pack, snapshot);
  }
  if (catalogs.size > 0) {
    postAiChatOrThrow({ type: "hydrateStickerCatalog", catalogs });
  }
}

/**
 * 要求 aiChatWorker 立即把所有 dirty 群的记忆快照、dirty 的贴纸目录上报
 * （进而转投 diskIOWorker 落盘），并等待完成。用于进程退出前的最后一刷
 * （握手样式同 infra/diskIO.ts 的 flushDiskIO）。带超时兜底：Worker 异常时
 * 停机流程最多被拖住 timeoutMs，不会挂死。
 */
export function flushAiMemory(timeoutMs: number = AI_MEMORY_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
  if (lastInitState.current === null) return Promise.resolve("flushed");
  return aiMemoryFlushBarrier.begin(
    (id) => post({ type: "flushMemory", flushId: id }),
    timeoutMs
  );
}

/** 停机时强制终止 AI Worker，保证它不会在 Disk I/O flush 后继续发布旧快照。 */
export async function terminateAiChat(): Promise<void> {
  aiMemoryFlushBarrier.settleAll("failed");
  rejectAllMoodSwitchWaiters("AI Worker is shutting down before acknowledging the mood switch.");
  aiChatWorkerState.available = false;
  purgedAiMemoryChats.clear();
  postPurgeAiMemoryPersistRevisions.clear();
  await terminateAiChatWorker();
}

/**
 * /switch_mood：要求 aiChatWorker 立即重抽某群的心情（心情缓存在 Worker 内，
 * 见 cache/aiChat/mood.ts），并等待带回执的新心情名。回复由调用方（主线程
 * 命令处理器）自行发送，Worker 不发 Telegram 消息。Worker 不可用、崩溃或
 * 回执超时（MOOD_SWITCH_TIMEOUT_MS）时 reject，由调用方兜底回复；同一超时
 * 也作为请求的绝对截止时刻，Worker 不执行积压到过期的重抽。
 */
export function switchAiMood(chatId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId: number = ++moodSwitchRequestCounter.current;
    const deadlineAt: number = Date.now() + MOOD_SWITCH_TIMEOUT_MS;
    const waiter: MoodSwitchWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        moodSwitchWaiters.delete(requestId);
        reject(new Error(
          `AI mood switch for chat ${chatId} timed out after ${MOOD_SWITCH_TIMEOUT_MS}ms.`
        ));
      }, MOOD_SWITCH_TIMEOUT_MS),
    };
    // 等待项在 post 之前登记，同步回执也不会丢（同 libs/flushBarrier.ts 的顺序约定）。
    moodSwitchWaiters.set(requestId, waiter);
    try {
      postAiChatOrThrow({ type: "switchMood", chatId, requestId, deadlineAt });
    } catch (error: unknown) {
      moodSwitchWaiters.delete(requestId);
      clearTimeout(waiter.timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 为 purge 后第一份新记忆武装即时持久化标志，并在投递失败时回滚新标志。 */
function postMemoryRecord(
  message: AiRecordMessage | AiRecordMediaMessage
): void {
  const armedRevision: number | null | undefined =
    postPurgeAiMemoryPersistRevisions.get(message.chatId);
  const wasArmed: boolean = postPurgeAiMemoryPersistRevisions.has(message.chatId);
  const shouldArm: boolean =
    !wasArmed &&
    (!latestAiMemories.has(message.chatId) && aiMemoryRevisionCounters.has(message.chatId));
  if (shouldArm) {
    postPurgeAiMemoryPersistRevisions.set(message.chatId, null);
  }
  try {
    postAiChatOrThrow({
      ...message,
      ...(shouldArm || armedRevision === null ? { persistImmediately: true } : {}),
    });
  } catch (error: unknown) {
    if (shouldArm) postPurgeAiMemoryPersistRevisions.delete(message.chatId);
    throw error;
  }
}

/**
 * 记录一条群消息到该群在 Worker 侧的滚动缓存，供之后拼装成对话上下文喂给
 * 模型。文本与昵称在 Worker 侧会被压成单行（防转录注入）。
 * @param chatId 群聊 ID。
 * @param senderId 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param username 发言人的公开 username（不含 @，没有则为 undefined）。
 * @param messageId 这条 Telegram 消息的 message_id，供回复引用精确关联。
 * @param replyTo 当前消息显式回复的原消息快照；非回复消息省略。
 * @param forwardedFrom 当前消息是转发时的来源标注（见 auto/message/facts.ts
 *   的 resolveForwardOrigin）；非转发省略。
 * @param text 消息文本。
 */
export function recordChatMessage(
  message: Omit<AiRecordMessage, "type" | "persistImmediately">
): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord({ type: "record", ...message });
}

/**
 * 记录一条图片/贴纸/GIF 消息：Worker 侧先以占位文本入缓存、异步解析媒体
 * 后原位回填描述（见 workers/aiChat/mediaIngest.ts 的 recordChatMedia）。默认
 * 只记上下文、不触发回复；commentOnResolve 为 true（主线程按本群
 * 近一小时活跃度掷中，与文字随机搭话共用同一个动态概率）时，解析成功
 * 后会以「回复那条消息」的形式发一条针对内容的评价。
 * @param kind 媒体类型：photo/sticker/animation，决定占位符/视觉提示词。
 * @param username 发言人的公开 username（不含 @，没有则为 undefined）。
 * @param replyTo 当前媒体显式回复的原消息快照；非回复消息省略。
 * @param forwardedFrom 当前媒体是转发时的来源标注；非转发省略。
 * @param caption 媒体自带的配文（没有则传空串）。
 * @param fileId 要下载的 file_id（图片是已挑好档位的 photo file_id；贴纸/
 *   GIF 是本体或缩略图，见 auto/message/facts.ts 的素材选择）。
 * @param fileUniqueId 描述去重缓存的键（贴纸/GIF 固定用媒体自身的
 *   file_unique_id，见 workers/aiChat/mediaIngest.ts 的 recordChatMedia 参数注释）。
 * @param width 实际交给视觉管线的本体/缩略图宽度，用于参考图生图的默认比例。
 * @param height 实际交给视觉管线的本体/缩略图高度。
 * @param messageId 这条消息的 message_id（评价回复挂引用用）。
 * @param commentOnResolve 是否在解析成功后评价这份媒体。
 * @param stickerFallbackText kind 为 "sticker" 时解析失败的兜底文本（现有
 *   元数据行，见 ai/stickers/sets.ts 的 describeStickerForContext）；其余
 *   kind 不传。
 * @param directTrigger 这份媒体是在明确跟机器人说话（回复机器人，或 caption
 *   里 @ 机器人）：描述就绪（命中缓存或解析完成，失败用兜底文本）后必触发
 *   一次直接回复，语义见 AiRecordMediaMessage.directTrigger；与
 *   commentOnResolve 互斥。
 */
export function recordChatMedia(
  message: Omit<AiRecordMediaMessage, "type" | "persistImmediately">
): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord({ type: "recordMedia", ...message });
}

export type GenerateAndSendReplyParams = Omit<AiTriggerMessage, "type" | "isRandomTrigger"> & {
  isRandomTrigger?: boolean;
};

/**
 * 触发一次 AI 回复：把触发事件投递给 Worker，由它做同群并发占位（在途
 * 轮数打满期间的回复/@ 触发排队等空位补跑，随机触发丢弃，见
 * workers/aiChat/replyPipeline.ts 的 generateAndSendReply）与限频判定并执行完整的
 * 生成与发送流程。fire-and-forget，主线程不等待任何结果。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID，回复/@ 触发时用它引用原消息。
 * @param imageGenerationRequested 当前触发是否具备图片工具调用资格：仅直接
 *   回复/@机器人为 true；具体是否有生图/修图意图由模型判断。
 * @param imageGenerationReference 当前图片/贴纸或被回复图片/贴纸的 Telegram 短期引用；
 *   只供本轮生图按需下载，不进入滚动记忆或持久化。
 * @param isRandomTrigger 是否是无人回复/@机器人、单纯按概率命中的随机插话
 *   （怎么接、挂不挂回复引用由模型判断，但必须回应——说话/贴纸/扣反应
 *   都算，不允许沉默；「插不插话」的闸门在触发概率那一层，见
 *   workers/aiChat/replyPipeline.ts 的 generateAndSendReply）。
 */
export function generateAndSendReply({
  chatId,
  triggerSenderId,
  replyToMessageId,
  imageGenerationRequested,
  imageGenerationReference,
  isRandomTrigger = false,
}: GenerateAndSendReplyParams): void {
  postAiChatOrThrow({
    type: "trigger",
    chatId,
    triggerSenderId,
    replyToMessageId,
    isRandomTrigger,
    imageGenerationRequested,
    ...(imageGenerationReference ? { imageGenerationReference } : {}),
  });
}

/**
 * 使某群当前回复代数失效并清空等候队列。/ai_chat disable 时调用；在途请求
 * 返回后也会因代数失配而停止发送和记忆回填。
 */
export async function invalidateAiChat(chatId: number, purgeMemory: boolean): Promise<void> {
  let persistedDelete: Promise<void> | undefined;
  if (purgeMemory) {
    if (aiChatWorkerState.available) purgedAiMemoryChats.add(chatId);
    persistedDelete = requestAiMemoryDelete(chatId, true);
  }
  if (aiChatWorkerState.available && !post({ type: "invalidateChat", chatId, purgeMemory })) {
    throw new Error("AI Worker is unavailable while invalidating chat runtime.");
  }
  await persistedDelete;
}

registerChatTeardown("aiChat", (chatId) => invalidateAiChat(chatId, true));
