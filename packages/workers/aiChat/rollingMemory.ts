import { logger } from "../../infra/logger";
import { BoundedDeque } from "../../libs/boundedDeque";
import { invalidInput } from "../../libs/inputValidation";
import { parseAiMemorySnapshot } from "../../libs/persistedSnapshotCodec";
import { isTelegramGroupChatId } from "../../libs/telegramId";
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
import { evictChatReplyGeneration, hasActiveAiChatTasks } from "./replyGeneration";
import type { AiMemorySnapshot, AiMemoryUsage, BufferedMessage } from "../../types/aiChat/memory";

/** 启动恢复时解析成功、等待按 savedAt 排序的一条群快照。 */
interface ParsedChatMemory {
  chatId: number;
  snapshot: AiMemorySnapshot;
}
import type {
  AiMemoryDeletedEvent,
  AiMemoryEvent,
  AiMemoryUsagesEvent,
  AiRecordMessage,
} from "../../types/aiChat/protocol";
import { buildBufferedMessage, normalizeHydratedBufferedMessage } from "./bufferedMessage";
import { scheduleRotation } from "./compaction";
import { indexBufferedMessage, unindexBufferedMessage } from "./bufferedMessageIndex";

declare const self: Worker;

/**
 * 各群滚动消息缓存的记录、轮换触发与快照落盘/恢复。轮换机制本身
 * （镜像块攒满 -> 压缩 -> 晋升）在 compaction.ts，本文件只负责往缓存里
 * 塞消息、按块边界触发轮换、以及缓存 <-> 快照 JSON 的序列化/反序列化。
 */

/**
 * 把一条已清洗好的缓存条目压进该群的滚动缓存，并按块边界触发轮换。
 * recordChatMessage 与 mediaIngest.ts 的 recordChatMedia 共用，条目由调用方构造并持有引用。
 *
 * 各群「最后一次有动静」的时间戳在这里更新为 now（chatLastActivityTimes，见
 * cache/workers/aiChat/memory.ts）：不论文字/媒体、也不论这条消息是否触发了 AI 回复，
 * 只要记进了滚动缓存就算；仅用于 ensureMemoryCapacity 的 LRU 淘汰排序。
 */
export function pushBufferedMessage(chatId: number, entry: BufferedMessage, now: number): void {
  if (!hasChatMemory(chatId)) ensureMemoryCapacity(chatId);
  chatLastActivityTimes.set(chatId, now);
  let buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    chatBuffers.set(chatId, buf);
  }
  buf.push(entry);
  indexBufferedMessage(chatId, entry);
  dirtyMemoryChats.add(chatId);
  // 轮换机制见 COMPACT_BATCH_SIZE 注释。push 每次 +1，两个 === 判等各自在块边界命中一次。
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
 * 文本与昵称都会被压成单行（见 libs/text.ts 的 sanitizeInline）。
 * @param message 主线程投递过来的整条记录载荷；逐字段语义见
 *   packages/types/aiChat/protocol.ts 的 AiRecordContext / AiRecordMessage。
 * @returns 写入热区的条目；清洗后没有正文时为 null。
 */
export function recordChatMessage(message: AiRecordMessage): BufferedMessage | null {
  const now: number = Date.now();
  const entry: BufferedMessage | null = buildBufferedMessage(message, message.text, now);
  if (entry) pushBufferedMessage(message.chatId, entry, now);
  return entry;
}

/**
 * 为一份新群记忆腾出容量；excludeChatId 永不作为本次淘汰对象。优先跳过
 * 仍有模型、发送链或其它代际任务在途的群，仅当所有候选都活跃时才按原始 LRU 淘汰。
 */
function ensureMemoryCapacity(excludeChatId: number): void {
  for (;;) {
    // chatMemoryIds() 每次重新构建 Set，同一轮淘汰内取一次共用。
    const memoryIds: Set<number> = chatMemoryIds();
    if (memoryIds.size < AI_MEMORY_MAX_CHATS) return;
    const findOldest = (excludeActiveReplies: boolean): number | undefined => {
      let oldestChatId: number | undefined;
      let oldestActivity: number = Number.POSITIVE_INFINITY;
      for (const candidate of memoryIds) {
        if (candidate === excludeChatId) continue;
        if (excludeActiveReplies && hasActiveAiChatTasks(candidate)) continue;
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

    evictChatReplyGeneration(oldestChatId);
    clearChatMemoryCache(oldestChatId);
    self.postMessage({ type: "memoryDeleted", chatId: oldestChatId } satisfies AiMemoryDeletedEvent);
  }
}

/** 把某群当前的滚动缓存 + 中期摘要 + 待晋升摘要序列化成一份紧凑的快照 JSON 文本。
 *  stringify 只在这里做一次：快照以字符串经「Worker -> 主线程 -> diskIOWorker」传递，
 *  落盘端校验后写入 `chat_states.ai_context`（见 types/aiChat/protocol.ts 的
 *  AiMemoryEvent.snapshot）。 */
function buildMemorySnapshot(chatId: number): string {
  const buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  const summaryQueue: BoundedDeque<string> | undefined = chatSummaries.get(chatId);
  const snapshot: AiMemorySnapshot = {
    version: 1,
    buffer: buf ? buf.last(buf.size) : [],
    summaries: summaryQueue ? summaryQueue.last(summaryQueue.size) : [],
    pendingSummary: pendingSummaries.get(chatId) ?? null,
    savedAt: Date.now(),
  };
  return JSON.stringify(snapshot);
}

/**
 * 取某群此刻的上下文占用量。两个计数直接读所属容器的 size，不遍历、不复制；
 * pendingSummaries 不计入冷区（见 types/aiChat/memory.ts 的 AiMemoryUsage）。
 */
function buildMemoryUsage(chatId: number): AiMemoryUsage {
  return {
    bufferedCount: chatBuffers.get(chatId)?.size ?? 0,
    summaryCount: chatSummaries.get(chatId)?.size ?? 0,
  };
}

/**
 * 上报单群当前快照；只有 dirty 时发送，成功交给主线程后清除 dirty。用于
 * purge 后第一条新记录的即时上报，也由普通批量 flush 复用。
 */
export function flushMemorySnapshot(chatId: number, persistImmediately: boolean = false): void {
  if (!dirtyMemoryChats.has(chatId)) return;
  // 字段一律发出，不用条件展开，事件形状固定；接收侧判 `persistImmediately === true`。
  self.postMessage({
    type: "memory",
    chatId,
    snapshot: buildMemorySnapshot(chatId),
    persistImmediately,
    usage: buildMemoryUsage(chatId),
  } satisfies AiMemoryEvent);
  dirtyMemoryChats.delete(chatId);
}

/**
 * 把所有 dirty 群的记忆快照 post 给主线程（进而转投 diskIOWorker 落盘），
 * 随后清空 dirty 标记。维护节拍（见 aiChatWorker.ts 的 runAiChatWorkerMaintenance）与
 * flushMemory（退出前最后一刷）共用。
 */
export function flushDirtyMemories(): void {
  if (dirtyMemoryChats.size === 0) return;
  for (const chatId of dirtyMemoryChats) flushMemorySnapshot(chatId);
}

/**
 * 启动时（或本 Worker 崩溃重启后）灌入持久化的记忆快照。只对内存里还没有
 * 数据的群生效，不覆盖已收到的新消息。
 *
 * buffer 只恢复最新 AI_MEMORY_HYDRATE_BUFFER_MAX 条（比 VERBATIM_CONTEXT_MAX 少一条），
 * 使 pushBufferedMessage 的 `size === VERBATIM_CONTEXT_MAX` 判等在下一次 push 仍可命中。
 * `=== COMPACT_BATCH_SIZE` 分支对恢复后 size 已达到该值的群不再触发，镜像语义由恢复的
 * pendingSummary 近似衔接，不复刻轮换状态机。
 *
 * chatLastActivityTimes 以快照的 savedAt 播种，供 LRU 淘汰排序；心情不在这里播种，
 * 由 aiChat/ai/mood.ts 的 currentMoodInstruction 在拼运行时状态区块时抽取。
 *
 * 恢复完成后一次性回传各群占用量（memoryUsages 事件），播种主线程展示用的
 * 只读镜像（见 cache/main/aiChat.ts 的 aiMemoryUsages）。
 */
export function hydrateMemories(memories: Map<number, string>): void {
  const parsedMemories: ParsedChatMemory[] = [];
  for (const [chatId, snapshotJson] of memories) {
    if (!isTelegramGroupChatId(chatId)) {
      return invalidInput(
        "AI memory hydrate payload",
        "$.memories.<key>",
        "a negative safe integer Telegram group or channel ID"
      );
    }
    const snapshot: AiMemorySnapshot = parseAiMemorySnapshot(
      snapshotJson,
      `AI memory hydrate payload for chat ${chatId}`
    );
    if (chatBuffers.has(chatId)) continue;
    parsedMemories.push({ chatId, snapshot });
  }

  parsedMemories.sort((left: ParsedChatMemory, right: ParsedChatMemory): number => right.snapshot.savedAt - left.snapshot.savedAt);
  let skippedOverCapacity: number = 0;
  // 容量判定随准入递增计数，循环内不重复调用 chatMemoryIds()。
  let memoryChatCount: number = chatMemoryIds().size;
  // 恢复出来的群在下一条新消息之前不 dirty，不产生 memory 事件；主线程的
  // 占用量镜像由本次 hydrate 播种（见下方 memoryUsages）。
  const usages: Map<number, AiMemoryUsage> = new Map();
  for (const { chatId, snapshot } of parsedMemories) {
    if (hasChatMemory(chatId)) continue;
    if (memoryChatCount >= AI_MEMORY_MAX_CHATS) {
      // 容量不足只跳过本轮水合，SQLite 快照保留；删除只由群状态或显式清理驱动。
      skippedOverCapacity++;
      continue;
    }

    const buf: BoundedDeque<BufferedMessage> =
      new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    for (const message of snapshot.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)) {
      // 条目形状归一后再入队，deque 内的条目对象形状一致。
      const normalized: BufferedMessage = normalizeHydratedBufferedMessage(message);
      buf.push(normalized);
      // 回复链索引不落盘，恢复热区的同时同源重建（见 cache/workers/aiChat/memory.ts）。
      indexBufferedMessage(chatId, normalized);
    }
    if (buf.size > 0) chatBuffers.set(chatId, buf);

    if (snapshot.summaries.length > 0) {
      const queue: BoundedDeque<string> = new BoundedDeque<string>(MAX_SUMMARY_ROUNDS);
      for (const summary of snapshot.summaries.slice(-MAX_SUMMARY_ROUNDS)) {
        queue.push(summary);
      }
      chatSummaries.set(chatId, queue);
    }

    if (snapshot.pendingSummary) {
      pendingSummaries.set(chatId, snapshot.pendingSummary);
    }
    if (hasChatMemory(chatId)) {
      // 只有留下内容的群才占容量名额。
      memoryChatCount++;
      chatLastActivityTimes.set(chatId, snapshot.savedAt);
      usages.set(chatId, buildMemoryUsage(chatId));
    } else {
      // 快照解析、校验通过但没有装进任何内容（buffer 空、无摘要、无待处理摘要）：
      // 上报 memoryDeleted 删除该快照。
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
    }
  }
  if (usages.size > 0) {
    self.postMessage({ type: "memoryUsages", usages } satisfies AiMemoryUsagesEvent);
  }
  if (skippedOverCapacity > 0) {
    logger.error(
      `Left the persisted AI memory of ${skippedOverCapacity} chat(s) on disk without hydrating it: ` +
      `the in-memory ceiling of ${AI_MEMORY_MAX_CHATS} chat(s) was already reached.`
    );
  }
}
