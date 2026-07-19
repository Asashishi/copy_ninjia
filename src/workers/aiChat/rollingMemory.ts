import { logger } from "../../infra/logger";
import { LinkedQueue } from "../../libs/linkedQueue";
import { formatTokyoTime } from "../../libs/time";
import { sanitizeInline } from "../../libs/text";
import { pickMood, recordActivityAndMaybeRerollMood } from "../../ai/mood";
import { AI_MEMORY_HYDRATE_BUFFER_MAX, AI_MEMORY_MAX_CHATS, COMPACT_BATCH_SIZE, MAX_SUMMARY_ROUNDS, VERBATIM_CONTEXT_MAX } from "../../consts/aiChat/memory";
import {
  chatBuffers,
  chatSummaries,
  chatMemoryIds,
  clearChatMemoryCache,
  dirtyMemoryChats,
  hasChatMemory,
  pendingSummaries,
} from "../../cache/aiChat/memory";
import { chatLastActivityTimes, chatMoods, clearChatMoodCache } from "../../cache/aiChat/mood";
import { invalidateChatRuntimeCache } from "../../cache/aiChat/index";
import type { AiMemorySnapshot, BufferedMessage } from "../../types/aiChat/memory";
import type { AiMemoryDeletedEvent, AiMemoryEvent } from "../../types/aiChat/protocol";
import { scheduleRotation } from "./compaction";

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
 * 心情系统的活跃度记录也挂在这里（见 ai/mood.ts 的
 * recordActivityAndMaybeRerollMood）：不论文字/媒体、也不论这条消息最终
 * 是否触发了 AI 回复，只要记进了滚动缓存就算「本群有动静」，必须放在
 * push 之前调用——判断的是这条消息到来之前的空窗时长。
 */
export function pushBufferedMessage(chatId: number, entry: BufferedMessage): void {
  if (!hasChatMemory(chatId)) ensureMemoryCapacity(chatId);
  recordActivityAndMaybeRerollMood(chatId);
  let buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf) {
    buf = new LinkedQueue<BufferedMessage>();
    chatBuffers.set(chatId, buf);
  }
  buf.push(entry);
  dirtyMemoryChats.add(chatId);
  // 轮换机制见 COMPACT_BATCH_SIZE 注释。push 每次只 +1，且轮换把 size 收回
  // COMPACT_BATCH_SIZE 后 push 不会再撞上下面第二个判等，两个 === 各自恰好
  // 在块边界命中一次。
  if (buf.size === VERBATIM_CONTEXT_MAX) {
    for (let i: number = 0; i < COMPACT_BATCH_SIZE; i++) {
      buf.shift();
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
 * @param id 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param username 发言人的公开 username（不含 @，没有则为 undefined）。
 * @param text 消息文本。
 */
export function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, username: string | undefined, text: string): void {
  const sanitized: string = sanitizeInline(text);
  if (!sanitized) return;
  const sanitizedUsername: string = sanitizeInline(username ?? "").replace(/^@+/, "");
  pushBufferedMessage(chatId, {
    id,
    firstName: sanitizeInline(firstName),
    lastName: sanitizeInline(lastName),
    ...(sanitizedUsername ? { username: sanitizedUsername } : {}),
    text: sanitized,
    at: formatTokyoTime(Date.now()),
  });
}

/** 删除某群全部可持久化记忆及其衍生运行时状态。 */
export function purgeChatMemory(chatId: number): void {
  clearChatMemoryCache(chatId);
  clearChatMoodCache(chatId);
}

/** 为一份新群记忆腾出容量；excludeChatId 永不作为本次淘汰对象。 */
function ensureMemoryCapacity(excludeChatId: number): void {
  for (;;) {
    // chatMemoryIds() 每次都从三个 Map 重新构建 Set，同一轮淘汰内取一次共用。
    const memoryIds: Set<number> = chatMemoryIds();
    if (memoryIds.size < AI_MEMORY_MAX_CHATS) return;
    let oldestChatId: number | undefined;
    let oldestActivity: number = Number.POSITIVE_INFINITY;
    for (const candidate of memoryIds) {
      if (candidate === excludeChatId) continue;
      const activity: number = chatLastActivityTimes.get(candidate) ?? 0;
      if (activity < oldestActivity) {
        oldestActivity = activity;
        oldestChatId = candidate;
      }
    }
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
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
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
 * 把所有 dirty 群的记忆快照 post 给主线程（进而转投 diskIOWorker 落盘），
 * 随后清空 dirty 标记。定时调用（见 aiChatWorker.ts 底部的 setInterval）以及
 * flushMemory（退出前最后一刷）共用。
 */
export function flushDirtyMemories(): void {
  if (dirtyMemoryChats.size === 0) return;
  for (const chatId of dirtyMemoryChats) {
    self.postMessage({ type: "memory", chatId, snapshot: buildMemorySnapshot(chatId) } satisfies AiMemoryEvent);
  }
  dirtyMemoryChats.clear();
}

/**
 * 启动时（或本 Worker 崩溃重启后）灌入持久化的记忆快照。只对内存里还没有
 * 数据的群生效——重启后本来就全空，天然成立，不会覆盖掉刚收到的新消息。
 *
 * buffer 只恢复最新 AI_MEMORY_HYDRATE_BUFFER_MAX（= VERBATIM_CONTEXT_MAX - 1）
 * 条：recordChatMessage 靠严格等值 `size === VERBATIM_CONTEXT_MAX` 触发轮换，
 * 若恰好灌回整 100 条，下一次 push 后 size 变 101，会永远错过这个判等，
 * 缓存无界增长。`=== COMPACT_BATCH_SIZE` 分支对恢复后 size ≥ 50 的群不再
 * 触发，镜像语义由恢复的 pendingSummary 近似衔接——极端情况某块摘要粒度
 * 略有漂移，可接受，不为此复刻轮换状态机。
 *
 * 恢复 chatLastActivityTimes 的同时必须顺手播种 chatMoods（见下方 pickMood
 * 调用）：ai/mood.ts 的 recordActivityAndMaybeRerollMood 靠
 * lastActivity===undefined 判断"本群第一次有动静、还没抽过心情"，若只恢复
 * 活动时间不恢复心情，该群在 savedAt 之后不到一个空窗阈值（2~4 小时）内
 * 再次说话就会被误判成"已经抽过"而跳过播种，提示词缺心情行直到真的沉默
 * 够久才补上——违反"任何触发都必已 record 过、mood 必已设置"的不变量。
 */
export function hydrateMemories(memories: Map<number, string>): void {
  const parsedMemories: { chatId: number; snapshot: AiMemorySnapshot }[] = [];
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

  parsedMemories.sort((left, right) => right.snapshot.savedAt - left.snapshot.savedAt);
  for (const { chatId, snapshot } of parsedMemories) {
    if (hasChatMemory(chatId)) continue;
    if (chatMemoryIds().size >= AI_MEMORY_MAX_CHATS) {
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
      continue;
    }

    const buf: LinkedQueue<BufferedMessage> = new LinkedQueue<BufferedMessage>();
    for (const message of snapshot.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)) {
      buf.push(message);
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
      // 播种心情，与"本群第一次有动静"的路径保持同一份不变量（见上方
      // 函数头注）；心情本身不落盘，这里跟真实的首条消息一样重新抽一次，
      // 不尝试恢复重启前的具体心情。
      chatMoods.set(chatId, pickMood());
    } else {
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
    }
  }
}
