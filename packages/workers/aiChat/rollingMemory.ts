import { logger } from "../../infra/logger";
import { LinkedQueue } from "../../libs/linkedQueue";
import { BoundedDeque } from "../../libs/boundedDeque";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, AI_MEMORY_MAX_CHATS, COMPACT_BATCH_SIZE, MAX_SUMMARY_ROUNDS, VERBATIM_CONTEXT_MAX } from "../../consts/aiChat/memory";
import {
  chatBuffers,
  chatLastActivityTimes,
  chatSummaries,
  chatMemoryIds,
  clearChatMemoryCache,
  dirtyMemoryChats,
  hasChatMemory,
  pendingSummaries,
} from "../../cache/workers/aiChat/memory";
import { clearChatMoodCache } from "../../cache/workers/aiChat/mood";
import { invalidateChatRuntimeCache } from "../../cache/workers/aiChat/index";
import { activeReplyCounts } from "../../cache/workers/aiChat/replies";
import type { AiMemorySnapshot, BufferedMessage } from "../../types/aiChat/memory";

/** 启动恢复时解析成功、等待按 savedAt 排序的一条群快照。 */
interface ParsedChatMemory {
  chatId: number;
  snapshot: AiMemorySnapshot;
}
import type { AiMemoryDeletedEvent, AiMemoryEvent, AiRecordMessage } from "../../types/aiChat/protocol";
import { buildBufferedMessage } from "./bufferedMessage";
import { scheduleRotation } from "./compaction";
import { indexBufferedMessage, unindexBufferedMessage } from "./replyChain";

declare const self: Worker;

/**
 * 各群滚动消息缓存的记录、轮换触发与快照落盘/恢复。轮换机制本身
 * （镜像块攒满 -> 压缩 -> 晋升）在 compaction.ts，本文件只负责往缓存里
 * 塞消息、按块边界触发轮换、以及缓存 <-> 快照 JSON 的序列化/反序列化。
 */

/**
 * 把一条已清洗好的缓存条目压进该群的滚动缓存，并按块边界触发轮换。
 * recordChatMessage / mediaIngest.ts 的 recordChatMedia 共用——后者需要拿住
 * 条目对象的引用以便异步回填描述，所以入队和构造条目分开。
 *
 * 各群「最后一次有动静」的时间戳也在这里更新（chatLastActivityTimes，见
 * cache/workers/aiChat/memory.ts）：不论文字/媒体、也不论这条消息最终是否触发了
 * AI 回复，只要记进了滚动缓存就算——仅用于容量满时 ensureMemoryCapacity
 * 的 LRU 淘汰排序，心情系统不看群活跃度（见 aiChat/ai/mood.ts）。
 */
export function pushBufferedMessage(chatId: number, entry: BufferedMessage): void {
  if (!hasChatMemory(chatId)) ensureMemoryCapacity(chatId);
  chatLastActivityTimes.set(chatId, Date.now());
  let buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    chatBuffers.set(chatId, buf);
  }
  buf.push(entry);
  indexBufferedMessage(chatId, entry);
  dirtyMemoryChats.add(chatId);
  // 轮换机制见 COMPACT_BATCH_SIZE 注释。push 每次只 +1，且轮换把 size 收回
  // COMPACT_BATCH_SIZE 后 push 不会再撞上下面第二个判等，两个 === 各自恰好
  // 在块边界命中一次。
  if (buf.size === VERBATIM_CONTEXT_MAX) {
    for (let i: number = 0; i < COMPACT_BATCH_SIZE; i++) {
      const removed: BufferedMessage | undefined = buf.shift();
      if (removed) unindexBufferedMessage(chatId, removed);
    }
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), true);
  } else if (buf.size === COMPACT_BATCH_SIZE) {
    // 本群的第一块刚攒满：成为首个镜像，只提交压缩，还没有可晋升的旧摘要。
    scheduleRotation(chatId, buf.last(COMPACT_BATCH_SIZE), false);
  }
}

/**
 * 记录一条群消息到该群的滚动缓存，供之后拼装成对话上下文喂给模型。
 * 文本与昵称都会被压成单行（见 sanitizeInline，防转录注入）。
 * @param chatId 群聊 ID。
 * @param senderId 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param username 发言人的公开 username（不含 @，没有则为 undefined）。
 * @param messageId 这条 Telegram 消息的 message_id，供回复引用精确关联。
 * @param replyTo 当前消息显式回复的原消息快照；非回复消息省略。
 * @param forwardedFrom 当前消息是转发时的来源标注；非转发省略。
 * @param text 消息文本。
 */
export function recordChatMessage(message: Omit<AiRecordMessage, "type">): void {
  const entry: BufferedMessage | null = buildBufferedMessage(message, message.text);
  if (entry) pushBufferedMessage(message.chatId, entry);
}

/** 删除某群全部可持久化记忆及其衍生运行时状态。 */
export function purgeChatMemory(chatId: number): void {
  clearChatMemoryCache(chatId);
  clearChatMoodCache(chatId);
}

/**
 * 为一份新群记忆腾出容量；excludeChatId 永不作为本次淘汰对象。优先跳过
 * 仍有回复轮次在途的群，仅当所有候选都活跃时才退化为按原始 LRU 淘汰。
 */
function ensureMemoryCapacity(excludeChatId: number): void {
  for (;;) {
    // chatMemoryIds() 每次都从三个 Map 重新构建 Set，同一轮淘汰内取一次共用。
    const memoryIds: Set<number> = chatMemoryIds();
    if (memoryIds.size < AI_MEMORY_MAX_CHATS) return;
    const findOldest = (excludeActiveReplies: boolean): number | undefined => {
      let oldestChatId: number | undefined;
      let oldestActivity: number = Number.POSITIVE_INFINITY;
      for (const candidate of memoryIds) {
        if (candidate === excludeChatId) continue;
        if (excludeActiveReplies && (activeReplyCounts.get(candidate) ?? 0) > 0) continue;
        const activity: number = chatLastActivityTimes.get(candidate) ?? 0;
        if (activity < oldestActivity) {
          oldestActivity = activity;
          oldestChatId = candidate;
        }
      }
      return oldestChatId;
    };
    const oldestChatId: number | undefined = findOldest(true) ?? findOldest(false);
    if (oldestChatId === undefined) return;

    invalidateChatRuntimeCache(oldestChatId);
    purgeChatMemory(oldestChatId);
    self.postMessage({ type: "memoryDeleted", chatId: oldestChatId } satisfies AiMemoryDeletedEvent);
  }
}

/** 把某群当前的滚动缓存 + 中期摘要 + 待晋升摘要序列化成一份可落盘的快照
 *  JSON 文本。stringify 只在这里做一次：此后「Worker -> 主线程 ->
 *  diskIOWorker」两跳 postMessage 克隆的都是字符串（近乎 memcpy，对象图
 *  则要走两次深克隆），落盘端原样写文件、不再重复序列化（见
 *  types/aiChat.ts 的 AiMemoryEvent.snapshot）。缩进固定 2 空格，与磁盘
 *  文件历史格式逐字节一致。 */
export function buildMemorySnapshot(chatId: number): string {
  const buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  const snapshot: AiMemorySnapshot = {
    version: 1,
    buffer: buf ? buf.last(buf.size) : [],
    summaries: summaryQueue ? summaryQueue.last(summaryQueue.size) : [],
    pendingSummary: pendingSummaries.get(chatId) ?? null,
    savedAt: Date.now(),
  };
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 上报单群当前快照；只有 dirty 时发送，成功交给主线程后清除 dirty。用于
 * purge 后第一条新记录的即时上报，也由普通批量 flush 复用。
 */
export function flushMemorySnapshot(chatId: number, persistImmediately: boolean = false): void {
  if (!dirtyMemoryChats.has(chatId)) return;
  self.postMessage({
    type: "memory",
    chatId,
    snapshot: buildMemorySnapshot(chatId),
    ...(persistImmediately ? { persistImmediately: true } : {}),
  } satisfies AiMemoryEvent);
  dirtyMemoryChats.delete(chatId);
}

/**
 * 把所有 dirty 群的记忆快照 post 给主线程（进而转投 diskIOWorker 落盘），
 * 随后清空 dirty 标记。定时调用（见 aiChatWorker.ts 底部的 setInterval）以及
 * flushMemory（退出前最后一刷）共用。
 */
export function flushDirtyMemories(): void {
  if (dirtyMemoryChats.size === 0) return;
  for (const chatId of dirtyMemoryChats) flushMemorySnapshot(chatId);
}

/**
 * 启动时（或本 Worker 崩溃重启后）灌入持久化的记忆快照。只对内存里还没有
 * 数据的群生效——重启后本来就全空，天然成立，不会覆盖掉刚收到的新消息。
 *
 * buffer 只恢复最新 AI_MEMORY_HYDRATE_BUFFER_MAX（= VERBATIM_CONTEXT_MAX - 1）
 * 条：recordChatMessage 靠严格等值 `size === VERBATIM_CONTEXT_MAX` 触发轮换，
 * 若恰好灌回整 VERBATIM_CONTEXT_MAX 条，下一次 push 会先撞上 deque 的领域硬
 * 上限，也没有机会执行轮换。`=== COMPACT_BATCH_SIZE` 分支对恢复后 size 已达到
 * 该值的群不再触发，镜像语义由恢复的 pendingSummary 近似衔接——极端情况某块
 * 摘要粒度略有漂移，可接受，不为此复刻轮换状态机。
 *
 * chatLastActivityTimes 以快照的 savedAt 近似播种，让恢复出来的群在 LRU
 * 淘汰排序里保持合理的新旧顺序；心情不落盘也不在这里播种，下次拼系统
 * 提示词时由 aiChat/ai/mood.ts 的 currentMoodInstruction 现抽。
 */
export function hydrateMemories(memories: Map<number, string>): void {
  const parsedMemories: ParsedChatMemory[] = [];
  for (const [chatId, snapshotJson] of memories) {
    if (chatBuffers.has(chatId)) continue;

    // 快照全程以序列化 JSON 文本流转（见 types/aiChat.ts），这里是整条
    // 管线唯一的解析点。文本只出自 buildMemorySnapshot 的 stringify 或
    // 启动恢复时逐字段重建后的重新 stringify，形状可信；解析失败按防御
    // 性丢弃处理，不让一份坏快照拦下其余群的恢复。
    let snapshot: AiMemorySnapshot;
    try {
      snapshot = JSON.parse(snapshotJson) as AiMemorySnapshot;
    } catch (error: unknown) {
      logger.error(`Failed to parse hydrated AI memory snapshot for chat ${chatId}, skipping it:`, error);
      continue;
    }

    // 语法合法但形状不符（例如 schema 变更后遗留的旧格式文件）同样按防御性
    // 丢弃处理：下方排序读 savedAt、恢复读 buffer/summaries/pendingSummary，
    // 任何一处形状不符都不能抛出未捕获异常拦下其余群的恢复——respawn 重放
    // 同一份坏数据会变成崩溃循环。
    if (
      typeof snapshot !== "object" || snapshot === null ||
      typeof snapshot.savedAt !== "number" ||
      !Array.isArray(snapshot.buffer) ||
      !Array.isArray(snapshot.summaries) ||
      (snapshot.pendingSummary !== null && snapshot.pendingSummary !== undefined && typeof snapshot.pendingSummary !== "string")
    ) {
      logger.error(`Hydrated AI memory snapshot for chat ${chatId} has an unexpected shape, skipping it`);
      continue;
    }

    parsedMemories.push({ chatId, snapshot });
  }

  parsedMemories.sort((left: ParsedChatMemory, right: ParsedChatMemory): number => right.snapshot.savedAt - left.snapshot.savedAt);
  for (const { chatId, snapshot } of parsedMemories) {
    if (hasChatMemory(chatId)) continue;
    if (chatMemoryIds().size >= AI_MEMORY_MAX_CHATS) {
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
      continue;
    }

    const buf: BoundedDeque<BufferedMessage> =
      new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    for (const message of snapshot.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)) {
      buf.push(message);
      // 回复链索引不落盘，恢复热区的同时同源重建（见 cache/workers/aiChat/memory.ts）。
      indexBufferedMessage(chatId, message);
    }
    if (buf.size > 0) chatBuffers.set(chatId, buf);

    if (snapshot.summaries.length > 0) {
      const queue: LinkedQueue<string> = new LinkedQueue<string>();
      for (const summary of snapshot.summaries.slice(-MAX_SUMMARY_ROUNDS)) {
        queue.push(summary);
      }
      chatSummaries.set(chatId, queue);
    }

    if (snapshot.pendingSummary) {
      pendingSummaries.set(chatId, snapshot.pendingSummary);
    }
    if (hasChatMemory(chatId)) {
      chatLastActivityTimes.set(chatId, snapshot.savedAt);
    } else {
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
    }
  }
}
