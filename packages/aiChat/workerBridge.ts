import { superviseDuplexWorker } from "../infra/supervisedDuplexWorker";
import { AI_CHAT_WORKER_URL } from "../consts/paths";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { logger } from "../infra/logger";
import { postDiskIO } from "../infra/diskIO";
import { relayAiCacheUsage } from "../infra/aiCacheUsageRelay";
import { isAiChatConfigured } from "./availability";
import { getAgentDeploymentConfig } from "../config/agent";
import { getMoodConfig } from "../config/mood";
import { getPersona } from "../config/persona";
import { getStickerConfig } from "../config/stickers";
import { beginAiMemoryTeardown, finishAiMemoryTeardown, nextAiMemoryRevision, requestAiMemoryDelete, settleAiMemoryTeardownWorker } from "./memoryMirror";
import {
  aiChatBotInfo,
  aiChatWorkerState,
  aiChatInvalidateRequestCounter,
  aiChatInvalidateWaiters,
  aiMemoryFlushBarrier,
  aiMemoryUsages,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  moodRequestCounter,
  moodRequestWaiters,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
  pendingAiMemoryTeardowns,
} from "../cache/main/aiChat";
import {
  AI_CHAT_INVALIDATE_TIMEOUT_MS,
  AI_MEMORY_FLUSH_TIMEOUT_MS,
} from "../consts/lifecycle";
import { MOOD_REQUEST_TIMEOUT_MS } from "../consts/aiChat/mood";
import type { FlushResult } from "../types/lifecycle";
import { adoptTtsUsage, getChatStateCache, getChatState, getTtsUsage } from "../infra/storage/stateStore";
import type {
  AiBotInfo,
  AiChatWorkerEvent,
  AiChatWorkerMessage,
  AiConfigReloadMessage,
  AiInitMessage,
} from "../types/aiChat/protocol";
import type { HotDeploymentConfigChanges } from "../types/config";
import { BOT_ATMOSPHERE, SUPER_ADMIN_USER_ID } from "../config/bot";
import type {
  AiChatInvalidateWaiter,
  AiMemoryTeardown,
  MoodRequestWaiter,
} from "../types/aiChat/waiters";
import type { SupervisedWorkerHandle } from "../infra/supervisedWorker";
import type { WorkerDuplexInbound } from "../types/workerDuplex";
import type { TelegramWorkerRequest } from "../types/telegramWorker";
import {
  handleAiWorkerTelegramRequest,
  telegramWorkerResponseTransfer,
} from "../infra/telegram/workerRequests";
import { toError } from "../libs/errorMessage";
import { activeStickerCatalogs, mirrorStickerCatalog, pruneStickerCatalogMirror } from "./stickerMirror";
import { failAllVoiceSynthesisWaiters, requestVoiceSynthesis, settleVoiceSynthesis } from "./voiceSynthesis";
import type { VoiceSynthesisRequest } from "./voiceSynthesis";
import type { VoiceSynthesisResult } from "../types/aiChat/voiceMessage";

/** 在途心情查询/重抽请求统一失败结算：Worker 崩溃重启/放弃/终止时，旧实例
 *  的回执不可能再到达，不结算会让命令处理器干等到超时。 */
function rejectAllMoodRequestWaiters(reason: string): void {
  for (const waiter of moodRequestWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  moodRequestWaiters.clear();
}

/** Worker 崩溃/终止时旧实例不可能再发送 invalidate 回执。 */
function rejectAllAiChatInvalidateWaiters(reason: string): void {
  for (const waiter of aiChatInvalidateWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  aiChatInvalidateWaiters.clear();
}

/**
 * AI 闲聊入口（主线程侧代理）。真正的回复流水线——滚动对话缓存、图片/
 * 贴纸/GIF 占位与异步描述、限频、拼装上下文、调模型（含 function
 * calling 往返与供应商内置的服务端联网检索）、工具化的发言/消息反应/两层应景贴纸
 * （见 packages/aiChat/ai/tools/replyToolset/）、白名单贴纸目录与整包简介生成——全部在独立
 * 的 Bun Worker（packages/workers/aiChatWorker.ts）里
 * 执行。主线程投递消息记录、回复触发、配置与生命周期消息，并接收快照、业务回执
 * 和 Telegram 能力请求；模型与其它外部 API 不经此边界。postMessage 按 FIFO 送达，
 * 同一群里「先记录、后触发」的先后顺序在 Worker 侧保持不变。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 infra/supervisedWorker.ts。
 *
 * AI 记忆持久化：aiChatWorker 定期把各群 dirty 的记忆快照（滚动缓存 + 中期
 * 摘要）、各白名单贴纸包 dirty 的目录快照上报到这里（memory / stickerCatalog
 * 事件），本模块各存一份镜像（latestAiMemories / latestStickerCatalogs）后
 * 转投 diskIOWorker 落盘。这份镜像与按 chat 单调递增的 revision、待确认删除
 * tombstone 一起构成双向崩溃重放来源：aiChatWorker 崩溃重启后凭镜像重放
 * hydrate（下方 onRespawn），diskIOWorker 崩溃重启后重放 tombstone 与最新快照。
 * revision 计数、tombstone 与删除回执 waiter 的维护函数都在
 * aiChat/memoryMirror.ts；本文件的 onEvent 负责在收到 memory/stickerCatalog
 * 事件时写入镜像并转投 diskIOWorker，另外保留 Worker 监督与对外 API。
 */

const { init: initAiChatWorker, post, terminate: terminateAiChatWorker }: SupervisedWorkerHandle<WorkerDuplexInbound<AiChatWorkerMessage>> = superviseDuplexWorker<AiChatWorkerMessage, AiChatWorkerEvent, TelegramWorkerRequest>({
  url: AI_CHAT_WORKER_URL,
  label: "AI Worker",
  giveUpConsequence: "AI chat feature will silently stay disabled until the process restarts.",
  handleRequest: handleAiWorkerTelegramRequest,
  responseTransfer: telegramWorkerResponseTransfer,
  onEvent: (event: AiChatWorkerEvent): void => {
    switch (event.type) {
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
          aiMemoryUsages.set(event.chatId, event.usage);
          // 字段一律发出，不用条件展开：这是上一跳（workers/aiChat/rollingMemory.ts
          // 的 memory 事件）的同一个字段再转投一手，两跳的产生频率完全相同。只修
          // 前一跳等于把形状发散往后挪了一格。落盘侧判的是 `=== true`，语义不变。
          postDiskIO({
            type: "aiMemory",
            chatId: event.chatId,
            revision,
            snapshot: event.snapshot,
            persistImmediately,
          });
        }
        break;
      case "memoryUsages":
        // hydrate 播种的占用量（见 workers/aiChat/rollingMemory.ts 的
        // hydrateMemories）。正在等待 purge 确认的群一律跳过：那一份记忆已经
        // 判了死刑，镜像不能被恢复出来的旧计数重新点亮。
        for (const [chatId, usage] of event.usages) {
          if (purgedAiMemoryChats.has(chatId)) continue;
          aiMemoryUsages.set(chatId, usage);
        }
        break;
      case "memoryDeleted":
        purgedAiMemoryChats.delete(event.chatId);
        requestAiMemoryDelete(event.chatId, false);
        break;
      case "stickerCatalog":
        mirrorStickerCatalog(event.pack, event.snapshot);
        break;
      case "memoryFlushed": {
        aiMemoryFlushBarrier.settle(event.flushId, "flushed");
        break;
      }
      case "chatInvalidated": {
        const teardown: AiMemoryTeardown | undefined = pendingAiMemoryTeardowns.get(event.chatId);
        if (teardown?.requestId === event.requestId) {
          teardown.workerSettled = true;
          finishAiMemoryTeardown(event.chatId);
        }
        const waiter: AiChatInvalidateWaiter | undefined =
          aiChatInvalidateWaiters.get(event.requestId);
        if (!waiter) break;
        aiChatInvalidateWaiters.delete(event.requestId);
        clearTimeout(waiter.timer);
        if (waiter.chatId !== event.chatId) {
          waiter.reject(new Error("AI Worker returned a mismatched chat invalidate receipt."));
        } else {
          waiter.resolve();
        }
        break;
      }
      case "moodQueried":
      case "moodSwitched": {
        const waiter: MoodRequestWaiter | undefined = moodRequestWaiters.get(event.requestId);
        if (!waiter) break;
        moodRequestWaiters.delete(event.requestId);
        clearTimeout(waiter.timer);
        if (waiter.chatId !== event.chatId || waiter.expectedEventType !== event.type) {
          waiter.reject(new Error("AI Worker returned a mismatched mood receipt."));
        } else {
          waiter.resolve(event.moodName);
        }
        break;
      }
      case "voiceSynthesized":
        settleVoiceSynthesis(event);
        break;
      case "ttsUsage":
        adoptTtsUsage(event.usage);
        break;
      case "aiCacheUsage":
        // 旁路统计：诊断通道未就绪时直接丢弃，不影响回复。
        relayAiCacheUsage(event.usage);
        break;
    }
  },
  onRespawn: (postToNext: (message: AiChatWorkerMessage) => boolean): void => {
    aiMemoryFlushBarrier.settleAll("failed");
    rejectAllMoodRequestWaiters("AI Worker crashed before acknowledging the mood request.");
    rejectAllAiChatInvalidateWaiters("AI Worker crashed before completing chat invalidation.");
    failAllVoiceSynthesisWaiters();
    settleAiMemoryTeardownWorker();
    // 新 Worker 重新走一遍身份注入与配置快照投递，FIFO 保证它先于任何
    // record/trigger 到达。重放的 init 带着主线程当前生效的配置快照（热重载由
    // syncAiChatConfig 同步改写），新 isolate 不自己读盘。重启发生在 initAiChat
    // 调用之前的话 lastInitState.current 仍是 null，没有可重放的，新 Worker 等
    // 本来就该来的那次 initAiChat 调用即可。
    if (lastInitState.current && !postToNext(lastInitState.current)) return;
    // 语音合成每日计数：新 Worker 从空值起步，凭主线程持有的最新回执恢复，
    // 排在任何 trigger/synthesizeVoice 之前到达。
    if (lastInitState.current && !postToNext({ type: "hydrateTtsUsage", usage: getTtsUsage() })) return;
    for (const [chatId, state] of getChatStateCache()) {
      if (state.aiPersona !== undefined && !postToNext({ type: "persona", chatId, persona: state.aiPersona })) return;
    }
    // 记忆镜像同样要重放：新 Worker 内存全空，凭上一实例上报过的最新快照
    // 补齐（见模块头注）。
    if (latestAiMemories.size > 0) {
      if (!postToNext({ type: "hydrate", memories: latestAiMemories })) return;
    }
    // 贴纸目录镜像同理：新 Worker 的 init 处理会重新 ensureStickerCatalogs，
    // 若不先灌回已生成的条目会白白重新调一遍视觉模型。
    if (latestStickerCatalogs.size > 0) {
      if (!postToNext({ type: "hydrateStickerCatalog", catalogs: activeStickerCatalogs() })) {
        logger.error("AI Worker sticker catalog replay was rejected.");
      }
    }
  },
  onGiveUp: (): void => {
    aiChatWorkerState.available = false;
    // 身份注入记录必须一起清掉：flushAiMemory 用 `lastInitState.current === null`
    // 判断「这条线根本没起来，没什么可刷的」并直接返回 flushed。
    lastInitState.current = null;
    // 同 onRespawn/terminateAiChat：立即结算全部等待者，不留给定时器超时兜底。
    aiMemoryFlushBarrier.settleAll("failed");
    rejectAllMoodRequestWaiters("AI Worker gave up restarting before acknowledging the mood request.");
    rejectAllAiChatInvalidateWaiters("AI Worker gave up before completing chat invalidation.");
    failAllVoiceSynthesisWaiters();
    // 已终止实例不可能再回传旧 memory；purged 只负责拒绝旧 Worker 快照。
    // pendingAiMemoryDeletes 由 Disk I/O durable 回执拥有，绝不能在这里清空。
    purgedAiMemoryChats.clear();
    // 尚未收到首份快照（null）的群已不可能由终止的 Worker 回传；已经投给
    // Disk I/O 的数字 revision 继续保留，供其重建时维持即时写盘语义。
    for (const [chatId, revision] of postPurgeAiMemoryPersistRevisions) {
      if (revision === null) postPurgeAiMemoryPersistRevisions.delete(chatId);
    }
    settleAiMemoryTeardownWorker();
  },
});

/** 向当前 AI Worker 投递协议消息；同步拒绝时关闭可用标记并抛错。 */
export function postAiChatOrThrow(message: AiChatWorkerMessage): void {
  if (post(message)) return;
  aiChatWorkerState.available = false;
  throw new Error("AI Worker is unavailable.");
}

/**
 * 启动 AI Worker 并注入身份与主线程当前生效的配置快照，再补发语音合成每日计数与各群人设。FIFO
 * 保证 init 先于一切 record/trigger 到达；Worker 靠它在转录里认出自己并自录自己
 * 发的消息。投递全部成功后才记 lastInitState 并发布可用标记：Worker 崩溃重启要
 * 重放这条消息，投递失败时两者都保持原值。调用方负责确认 AI 前提的 holder 已齐
 * （启动走 readiness，热重载走 config/readiness.ts 的 aiChatReadinessFromHolders）。
 */
export function startAiChatWorker(botInfo: AiBotInfo): void {
  pruneStickerCatalogMirror(getStickerConfig().packs);
  initAiChatWorker();
  const message: AiInitMessage = {
    type: "init",
    botInfo,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    defaultAtmosphere: BOT_ATMOSPHERE,
    agent: getAgentDeploymentConfig(),
    mood: getMoodConfig(),
    stickers: getStickerConfig(),
    persona: getPersona(),
  };
  postAiChatOrThrow(message);
  postAiChatOrThrow({ type: "hydrateTtsUsage", usage: getTtsUsage() });
  for (const [chatId, state] of getChatStateCache()) {
    if (state.aiPersona !== undefined) postAiChatOrThrow({ type: "persona", chatId, persona: state.aiPersona });
  }
  lastInitState.current = message;
  aiChatWorkerState.available = true;
}

/**
 * 记下机器人自己的账号身份，AI 前提可用时启动 AI Worker。须在 bot.init() 之后、
 * runner 开始投喂更新之前调用一次（见 app/lifecycle.ts）。
 *
 * 前提不可用时整条线不启动：连线程都不建，lastInitState 保持 null，停机路径上的
 * flushAiMemory 因此直接返回 flushed、terminateAiChat 面对空 worker 也是 no-op
 * （见 infra/supervisedWorker.ts）。身份照样记下，config/dynamic/ 热重载补齐前提时由
 * aiChat/hydration.ts 的 resumeAiChat 据此启动。
 */
export function initAiChat(botInfo: AiBotInfo): void {
  const identity: AiBotInfo = { id: botInfo.id, username: botInfo.username, first_name: botInfo.first_name };
  aiChatBotInfo.current = identity;
  if (!isAiChatConfigured()) {
    logger.log("AI agent configuration is unavailable; the AI chat worker stays down and /ai_chat enable is refused.");
    return;
  }
  startAiChatWorker(identity);
}

/** syncAiChatConfig 要重投的配置领域；与 HotDeploymentConfigChanges 的同名字段一致。 */
export type AiConfigDomains = Pick<HotDeploymentConfigChanges, "aiAgent" | "mood" | "stickers">;

/**
 * 把主线程已生效的 AI 配置投给 AI Worker（见 app/configReload.ts 与
 * aiChat/hydration.ts 的 resumeAiChat）。
 *
 * 先把 lastInitState 改写成当前快照再投递：投递被拒绝（Worker 正在重建）时，
 * 重建重放的 init 已经带着这一份。Worker 从未启动时 lastInitState 为 null，直接
 * 返回。调用方保证三份 holder 此刻都非空。
 */
export function syncAiChatConfig(domains: AiConfigDomains): void {
  if (domains.stickers) pruneStickerCatalogMirror(getStickerConfig().packs);
  const init: AiInitMessage | null = lastInitState.current;
  if (init === null) return;
  lastInitState.current = {
    ...init,
    agent: getAgentDeploymentConfig(),
    mood: getMoodConfig(),
    stickers: getStickerConfig(),
  };
  const message: AiConfigReloadMessage = {
    type: "configReload",
    agent: domains.aiAgent ? getAgentDeploymentConfig() : undefined,
    mood: domains.mood ? getMoodConfig() : undefined,
    stickers: domains.stickers ? getStickerConfig() : undefined,
  };
  if (!post(message)) {
    logger.error("AI Worker rejected the deployment config reload; the next respawn replays the reloaded snapshot.");
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
    (id: number): boolean => post({ type: "flushMemory", flushId: id }),
    timeoutMs
  );
}

/** 停机时强制终止 AI Worker，保证它不会在 Disk I/O flush 后继续发布旧快照。 */
export async function terminateAiChat(): Promise<void> {
  aiMemoryFlushBarrier.settleAll("failed");
  rejectAllMoodRequestWaiters("AI Worker is shutting down before acknowledging the mood request.");
  rejectAllAiChatInvalidateWaiters("AI Worker is shutting down before completing chat invalidation.");
  failAllVoiceSynthesisWaiters();
  aiChatWorkerState.available = false;
  purgedAiMemoryChats.clear();
  postPurgeAiMemoryPersistRevisions.clear();
  await terminateAiChatWorker();
  settleAiMemoryTeardownWorker();
}

/**
 * 向 aiChatWorker 查询或重抽某群心情，并等待带 requestId 的结果回执。两类
 * 请求共用等待表、编号空间与超时生命周期；Worker 不发 Telegram 消息。
 */
function requestAiMood(
  chatId: number,
  requestType: "queryMood" | "switchMood"
): Promise<string> {
  return new Promise((resolve: (value: string | PromiseLike<string>) => void, reject: (reason?: unknown) => void): void => {
    const requestId: number = ++moodRequestCounter.current;
    const deadlineAt: number = Date.now() + MOOD_REQUEST_TIMEOUT_MS;
    const waiter: MoodRequestWaiter = {
      chatId,
      expectedEventType: requestType === "queryMood" ? "moodQueried" : "moodSwitched",
      resolve,
      reject,
      timer: setTimeout((): void => {
        moodRequestWaiters.delete(requestId);
        reject(new Error(
          `AI ${requestType} request for chat ${chatId} timed out after ${MOOD_REQUEST_TIMEOUT_MS}ms.`
        ));
      }, MOOD_REQUEST_TIMEOUT_MS),
    };
    // 等待项在 post 之前登记，同步回执也不会丢（同 libs/flushBarrier.ts 的顺序约定）。
    moodRequestWaiters.set(requestId, waiter);
    try {
      postAiChatOrThrow({ type: requestType, chatId, requestId, deadlineAt });
    } catch (error: unknown) {
      moodRequestWaiters.delete(requestId);
      clearTimeout(waiter.timer);
      reject(toError(error));
    }
  });
}

/**
 * /mood query：读取某群当前有效心情；自然到期仍由 Worker 的 currentMood
 * 统一处理，但不会强制切换尚未到期的心情。
 */
export function queryAiMood(chatId: number): Promise<string> {
  return requestAiMood(chatId, "queryMood");
}

/**
 * /mood switch：要求 Worker 无视剩余寿命立即重抽，并带回新心情名。
 */
export function switchAiMood(chatId: number): Promise<string> {
  return requestAiMood(chatId, "switchMood");
}

/**
 * `/send` 代发 TTS 与 cron `send_voice` 的语音合成入口：把台词与语气交给 AI Worker 的
 * 公共实现，拿回编码好的语音；等待、取消与结算见 aiChat/voiceSynthesis.ts。AI Worker
 * 没在运行（AI 前提不齐或已放弃重启）时按「worker unavailable」返回。
 */
export function synthesizeVoice(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
  return requestVoiceSynthesis(request, {
    post,
    workerAvailable: aiChatWorkerState.available && lastInitState.current !== null,
  });
}

/**
 * 使某群当前回复代数失效、清空等候队列并删除该群的 AI 记忆。/ai_chat disable、
 * /clear_context 与群级 teardown 共用这一条路；在途请求返回后也会因代数失配而
 * 停止发送和记忆回填。
 */
export async function invalidateAiChat(chatId: number): Promise<void> {
  if (aiChatWorkerState.available) purgedAiMemoryChats.add(chatId);
  const persistedDelete: Promise<void> = requestAiMemoryDelete(chatId, true);
  let workerInvalidated: Promise<void> | undefined;
  if (aiChatWorkerState.available) {
    const requestId: number = ++aiChatInvalidateRequestCounter.current;
    const teardown: AiMemoryTeardown | undefined = pendingAiMemoryTeardowns.get(chatId);
    if (teardown !== undefined) teardown.requestId = requestId;
    workerInvalidated = new Promise(
      (resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          aiChatInvalidateWaiters.delete(requestId);
          reject(new Error(
            `AI chat invalidation for chat ${chatId} timed out after ${AI_CHAT_INVALIDATE_TIMEOUT_MS}ms.`
          ));
        }, AI_CHAT_INVALIDATE_TIMEOUT_MS);
        aiChatInvalidateWaiters.set(requestId, { chatId, resolve, reject, timer });
      }
    );
    if (!post({ type: "invalidateChat", chatId, requestId })) {
      const waiter: AiChatInvalidateWaiter | undefined = aiChatInvalidateWaiters.get(requestId);
      aiChatInvalidateWaiters.delete(requestId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("AI Worker is unavailable while invalidating chat runtime."));
      }
    }
  }
  const settlements: PromiseSettledResult<void>[] = await Promise.allSettled([
    persistedDelete,
    workerInvalidated ?? Promise.resolve(),
  ]);
  const labels: readonly string[] = ["durable memory deletion", "Worker runtime invalidation"];
  const failures: unknown[] = [];
  for (let index: number = 0; index < settlements.length; index++) {
    const settlement: PromiseSettledResult<void> = settlements[index]!;
    if (settlement.status === "fulfilled") continue;
    logger.error(
      `AI chat ${labels[index]} rejected for chat ${chatId}:`,
      settlement.reason
    );
    failures.push(settlement.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `AI chat invalidation failed for chat ${chatId}.`);
  }
}

registerChatTeardown("aiChat", async (chatId: number): Promise<void> => {
  beginAiMemoryTeardown(chatId);
  try {
    await invalidateAiChat(chatId);
  } finally {
    finishAiMemoryTeardown(chatId);
  }
});

/** 人设配置或群状态删除 durable 后发布最终值；AI 未配置时由下次初始化恢复。 */
export function syncAiChatPersona(chatId: number): void {
  if (!aiChatWorkerState.available) return;
  postAiChatOrThrow({ type: "persona", chatId, persona: getChatState(chatId).aiPersona ?? null });
}
