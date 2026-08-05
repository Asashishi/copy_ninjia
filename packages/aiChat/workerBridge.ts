import { superviseWorker } from "../libs/supervisedWorker";
import { markSelfSent } from "../infra/selfSentTracker";
import { registerChatTeardown } from "../infra/chatTeardown";
import { logger } from "../infra/logger";
import { postDiskIO } from "../infra/diskIO";
import { isAiChatConfigured } from "./availability";
import { forgetAiMemoryRevisionCounter, nextAiMemoryRevision, requestAiMemoryDelete } from "./memoryMirror";
import {
  aiChatWorkerState,
  aiChatInvalidateRequestCounter,
  aiChatInvalidateWaiters,
  aiMemoryFlushBarrier,
  aiMemoryRevisionCounters,
  lastInitState,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  moodRequestCounter,
  moodRequestWaiters,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
} from "../cache/main/aiChat";
import {
  AI_CHAT_INVALIDATE_TIMEOUT_MS,
  AI_MEMORY_FLUSH_TIMEOUT_MS,
} from "../consts/lifecycle";
import { MOOD_REQUEST_TIMEOUT_MS } from "../consts/aiChat/mood";
import type { FlushResult } from "../types/lifecycle";
import { getAllChatStates, getChatProviderOverride, getChatState, getImageProviderOverride } from "../infra/storage/stateStore";
import type { AiProviderName } from "../types/aiChat/provider";
import type {
  AiBotInfo,
  AiChatWorkerEvent,
  AiChatWorkerMessage,
  AiInitMessage,
} from "../types/aiChat/protocol";
import type {
  AiChatInvalidateWaiter,
  MoodRequestWaiter,
} from "../types/aiChat/waiters";
import type { SupervisedWorkerHandle } from "../libs/supervisedWorker";

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

const { init: initAiChatWorker, post, terminate: terminateAiChatWorker }: SupervisedWorkerHandle<AiChatWorkerMessage> = superviseWorker<AiChatWorkerMessage, AiChatWorkerEvent>({
  url: new URL("../workers/aiChatWorker.ts", import.meta.url).href,
  label: "AI Worker",
  giveUpConsequence: "AI chat feature will silently stay disabled until the process restarts.",
  onEvent: (event: AiChatWorkerEvent): void => {
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
      case "chatInvalidated": {
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
    }
  },
  onRespawn: (postToNext: (message: AiChatWorkerMessage) => boolean): void => {
    aiMemoryFlushBarrier.settleAll("failed");
    rejectAllMoodRequestWaiters("AI Worker crashed before acknowledging the mood request.");
    rejectAllAiChatInvalidateWaiters("AI Worker crashed before completing chat invalidation.");
    // 新 Worker 重新走一遍身份注入，FIFO 保证它先于任何 record/trigger 到达。
    // 重启发生在 initAiChat 调用之前的话 lastInitState.current 仍是 null，
    // 没有可重放的，新 Worker 等本来就该来的那次 initAiChat 调用即可。
    if (lastInitState.current && !postToNext(lastInitState.current)) return;
    // 生图供应商覆盖同样要重放：新 Worker 的镜像是空的，而空的含义是「跟随默认
    // 供应商」——不补发就等于超管切过的那一下被静默回滚，而群里看不出区别
    // （见 cache/workers/aiChat/imageProvider.ts）。没设过覆盖时无须推送，空镜像
    // 本身就是正确结论。
    const imageProvider: AiProviderName | undefined = getImageProviderOverride();
    if (imageProvider !== undefined && !postToNext({ type: "imageProvider", provider: imageProvider })) return;
    // 闲聊侧覆盖同理，两份镜像各推各的（见 cache/workers/aiChat/chatProvider.ts）。
    const chatProvider: AiProviderName | undefined = getChatProviderOverride();
    if (chatProvider !== undefined && !postToNext({ type: "chatProvider", provider: chatProvider })) return;
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
  onGiveUp: (): void => {
    aiChatWorkerState.available = false;
    // 身份注入记录必须一起清掉：flushAiMemory 用 `lastInitState.current === null`
    // 判断「这条线根本没起来，没什么可刷的」并直接返回 flushed。放弃重启后
    // worker 已经是 null，留着这份记录只会让停机时的 flushAiMemory 越过短路、
    // 进 barrier 后因 post 失败结算成 "failed"，于是 flushAllToDisk 返回 false、
    // wait() 拒绝确认最终 offset，Telegram 重投上次确认点之后的全部更新，重复
    // 执行复读/命令回执这些非幂等副作用。而本功能既定的降级只是「AI 闲聊静默
    // 停用到下次重启」，不该牵连整个停机的 offset 闸门。
    lastInitState.current = null;
    // 同 onRespawn/terminateAiChat：不结算的话等待者只能等定时器过期，停机白等
    // 一整份 flush 预算，还会挤占紧急退出路径上共享的那份时间。
    aiMemoryFlushBarrier.settleAll("failed");
    rejectAllMoodRequestWaiters("AI Worker gave up restarting before acknowledging the mood request.");
    rejectAllAiChatInvalidateWaiters("AI Worker gave up before completing chat invalidation.");
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

/** 向当前 AI Worker 投递协议消息；同步拒绝时关闭可用标记并抛错。 */
export function postAiChatOrThrow(message: AiChatWorkerMessage): void {
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
 *
 * 两把供应商凭据都缺时整条线不启动：连线程都不建，lastInitState 保持 null，停机
 * 路径上的 flushAiMemory 因此直接返回 flushed、terminateAiChat 面对空 worker
 * 也是 no-op（见 libs/supervisedWorker.ts），生命周期那边不必分岔。判定放在
 * 这里而不是 app/lifecycle.ts：那边只认注入进来的 dependencies，把「这个功能
 * 配没配」的知识摊到编排层等于每加一个可选功能都要改一次生命周期。
 */
export function initAiChat(botInfo: AiBotInfo): void {
  if (!isAiChatConfigured()) {
    logger.log("No AI chat provider credential is configured; the AI chat worker stays down and /ai_chat enable is refused.");
    return;
  }
  initAiChatWorker();
  const message: AiInitMessage = {
    type: "init",
    botInfo: { id: botInfo.id, username: botInfo.username, first_name: botInfo.first_name },
  };
  postAiChatOrThrow(message);
  lastInitState.current = message;
  aiChatWorkerState.available = true;
  // 首个 Worker 拿不到 onRespawn 的那次重放，恢复出来的覆盖值在这里补推一次。
  // 必须在 loadState 之后调用（见 app/lifecycle.ts 的顺序）。
  const imageProvider: AiProviderName | undefined = getImageProviderOverride();
  if (imageProvider !== undefined) postAiChatOrThrow({ type: "imageProvider", provider: imageProvider });
  const chatProvider: AiProviderName | undefined = getChatProviderOverride();
  if (chatProvider !== undefined) postAiChatOrThrow({ type: "chatProvider", provider: chatProvider });
}

/**
 * 把 `/image_model` 刚写下的覆盖值推给 AI Worker。
 *
 * 落盘已经在调用方完成，因此这里的失败**不上抛**：放它逃出去会让这条 update
 * 判失败、最终 offset 被扣住，Telegram 重投同一条命令——而 Worker 仍然不可用，
 * 重投同样失败（口径同 commands/adDetect.ts 的运行时清理）。Worker 只是重生中
 * 的话，onRespawn 的重放会把当前值补上；已放弃重启的话整条 AI 闲聊本来就停了。
 */
export function publishImageProvider(provider: AiProviderName): void {
  if (post({ type: "imageProvider", provider })) return;
  logger.error(`Failed to publish the image provider override "${provider}" to the AI Worker; it is unavailable.`);
}

/**
 * 把 `/chat_model` 刚写下的覆盖值推给 AI Worker。失败不上抛的理由与
 * publishImageProvider 完全一致，见上。
 */
export function publishChatProvider(provider: AiProviderName): void {
  if (post({ type: "chatProvider", provider })) return;
  logger.error(`Failed to publish the chat provider override "${provider}" to the AI Worker; it is unavailable.`);
}

/**
 * 启动时把 diskIOWorker 落盘恢复出的 AI 记忆快照灌回来：先存一份镜像
 * （供后续崩溃重放，见模块头注），再投递给 Worker 做 hydrate。必须在
 * initAiChat 之后、runner 开始投喂更新之前调用（见 app/lifecycle.ts），FIFO 保证
 * hydrate 消息先于一切 record/trigger 到达。
 *
 * 顺带回收磁盘残留：本群已经关掉 AI 闲聊，它那份记忆就该跟着走。这一步是
 * **不可逆的删除**，因此判据收得很紧——只有在下面两个前提都成立时才动手，
 * 任何一个不成立都宁可留着文件（留下的是可回收的垃圾，删错的是找不回来的数据）：
 *
 * 1. 进程侧前提齐备（isAiChatConfigured）。缺 key 时每个群看起来都是关的，
 *    不拦的话一次临时抽掉密钥的重启就把所有群的记忆一起抹掉。
 * 2. `state.json` 确实认识这个群。「群在状态表里、但开关不是 true」才是管理员
 *    关掉了它；「群根本不在状态表里」说明状态自己丢了（LKG 回滚等），这时
 *    没有任何权威依据支持删除——那恰恰是最该保住记忆的时刻。
 *
 * 两类结果都记一行日志：删除本身没有别的痕迹，出了事连"删过什么"都查不到。
 */
export function hydrateAiMemory(memories: Map<number, string>): void {
  if (!isAiChatConfigured()) return;
  const knownChats: ReadonlyMap<number, unknown> = getAllChatStates();
  const enabledMemories: Map<number, string> = new Map();
  const dropped: number[] = [];
  const keptWithoutChatState: number[] = [];
  for (const [chatId, snapshot] of memories) {
    if (getChatState(chatId).isAIChatEnabled !== true) {
      if (!knownChats.has(chatId)) {
        keptWithoutChatState.push(chatId);
        continue;
      }
      dropped.push(chatId);
      requestAiMemoryDelete(chatId, false);
      continue;
    }
    latestAiMemories.set(chatId, snapshot);
    latestAiMemoryRevisions.set(chatId, 0);
    aiMemoryRevisionCounters.set(chatId, 0);
    enabledMemories.set(chatId, snapshot);
  }
  if (dropped.length > 0) {
    logger.log(`Dropping the persisted AI memory of ${dropped.length} chat(s) with AI chat disabled: ${dropped.join(", ")}.`);
  }
  if (keptWithoutChatState.length > 0) {
    logger.error(
      `Keeping the persisted AI memory of ${keptWithoutChatState.length} chat(s) absent from state.json ` +
      `(${keptWithoutChatState.join(", ")}); restore or re-enter those chats, or delete the files by hand.`
    );
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
  if (!isAiChatConfigured()) return;
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
    (id: number): boolean => post({ type: "flushMemory", flushId: id }),
    timeoutMs
  );
}

/** 停机时强制终止 AI Worker，保证它不会在 Disk I/O flush 后继续发布旧快照。 */
export async function terminateAiChat(): Promise<void> {
  aiMemoryFlushBarrier.settleAll("failed");
  rejectAllMoodRequestWaiters("AI Worker is shutting down before acknowledging the mood request.");
  rejectAllAiChatInvalidateWaiters("AI Worker is shutting down before completing chat invalidation.");
  aiChatWorkerState.available = false;
  purgedAiMemoryChats.clear();
  postPurgeAiMemoryPersistRevisions.clear();
  await terminateAiChatWorker();
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
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * /query_mood：读取某群当前有效心情；自然到期仍由 Worker 的 currentMood
 * 统一处理，但不会强制切换尚未到期的心情。
 */
export function queryAiMood(chatId: number): Promise<string> {
  return requestAiMood(chatId, "queryMood");
}

/**
 * /switch_mood：要求 Worker 无视剩余寿命立即重抽，并带回新心情名。
 */
export function switchAiMood(chatId: number): Promise<string> {
  return requestAiMood(chatId, "switchMood");
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
  let workerInvalidated: Promise<void> | undefined;
  if (aiChatWorkerState.available) {
    const requestId: number = ++aiChatInvalidateRequestCounter.current;
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
    if (!post({ type: "invalidateChat", chatId, purgeMemory, requestId })) {
      const waiter: AiChatInvalidateWaiter | undefined = aiChatInvalidateWaiters.get(requestId);
      aiChatInvalidateWaiters.delete(requestId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("AI Worker is unavailable while invalidating chat runtime."));
      }
    }
  }
  await Promise.all([
    persistedDelete ?? Promise.resolve(),
    workerInvalidated ?? Promise.resolve(),
  ]);
}

registerChatTeardown("aiChat", async (chatId: number): Promise<void> => {
  await invalidateAiChat(chatId, true);
  // AI 记忆这套状态里唯一没有容量上界的一张表；只有 teardown 能摘，见该函数。
  forgetAiMemoryRevisionCounter(chatId);
});
