import { logger } from "../../infra/logger";
import { LinkedQueue } from "../../libs/linkedQueue";
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
import { clearChatMoodCache } from "../../cache/workers/aiChat/mood";
import { invalidateChatRuntimeCache } from "../../cache/workers/aiChat/index";
import { hasActiveAiChatTasks } from "./replyGeneration";
import type { AiMemorySnapshot, BufferedMessage } from "../../types/aiChat/memory";

/** 启动恢复时解析成功、等待按 savedAt 排序的一条群快照。 */
interface ParsedChatMemory {
  chatId: number;
  snapshot: AiMemorySnapshot;
}
import type { AiMemoryDeletedEvent, AiMemoryEvent, AiRecordMessage } from "../../types/aiChat/protocol";
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
 * @param message 主线程投递过来的整条记录载荷；逐字段语义见
 *   packages/types/aiChat/protocol.ts 的 AiRecordContext / AiRecordMessage
 *   （那里也写明了字段必须一次性齐备、不得事后补键的理由）。
 */
export function recordChatMessage(message: AiRecordMessage): void {
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
 * 仍有模型、发送链或其它代际任务在途的群，仅当所有候选都活跃时才按原始 LRU 淘汰。
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
function buildMemorySnapshot(chatId: number): string {
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
  // 字段一律发出，不用条件展开：flushDirtyMemories 每个维护 tick 都会对所有
  // dirty 群走这里，两种形状轮着产生会让主线程 aiChat/workerBridge.ts 的
  // onEvent 多态读 `event.persistImmediately`（AGENTS.md：不得事后增删字段）。
  // 语义不变——接收侧判的是 `=== true`。
  self.postMessage({
    type: "memory",
    chatId,
    snapshot: buildMemorySnapshot(chatId),
    persistImmediately,
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
  // 容量判定随准入递增，不在循环里反复重建 Set：chatMemoryIds() 每次
  // 都要新建一个 Set 并完整遍历 chatBuffers / chatSummaries / pendingSummaries，
  // 逐群调用就把启动恢复变成 O(n²)（同 ensureMemoryCapacity 已经写下的取舍）。
  let memoryChatCount: number = chatMemoryIds().size;
  for (const { chatId, snapshot } of parsedMemories) {
    if (hasChatMemory(chatId)) continue;
    if (memoryChatCount >= AI_MEMORY_MAX_CHATS) {
      // 超出容量只是「这一轮装不下」，不是「这份记忆该没了」。这里发
      // memoryDeleted 会被主线程路由到 requestAiMemoryDelete，最终 unlink 掉
      // memory/ai/<chatId>.json：105 个群开着 AI 闲聊时，一次 systemctl restart
      // 就让 savedAt 最旧的 5 个群的逐字缓冲、中期摘要和待处理摘要从磁盘永久
      // 消失，且触发条件只是「重启」。运行期的淘汰路径 ensureMemoryCapacity
      // ——它至少会跳过有回复在途的群。这里只跳过不加载，文件留在盘上；真要
      // 回收得走独立的过期策略，不能挂在容量判定上。
      skippedOverCapacity++;
      continue;
    }

    const buf: BoundedDeque<BufferedMessage> =
      new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX);
    for (const message of snapshot.buffer.slice(-AI_MEMORY_HYDRATE_BUFFER_MAX)) {
      // 形状归一后再入队：JSON.parse 出来的条目按各自记录时有没有可选字段分成
      // 好几个隐藏类，直接灌进 deque 会让转录渲染在重启后长期读多种形状。
      const normalized: BufferedMessage = normalizeHydratedBufferedMessage(message);
      buf.push(normalized);
      // 回复链索引不落盘，恢复热区的同时同源重建（见 cache/workers/aiChat/memory.ts）。
      indexBufferedMessage(chatId, normalized);
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
      // 只有真正留下了内容才算占一个名额——下面那条分支什么都没装进来。
      memoryChatCount++;
      chatLastActivityTimes.set(chatId, snapshot.savedAt);
    } else {
      // 与上面的超容量分支不同：这份快照解析、校验都过了，装进来却什么都没
      // 留下（buffer 空、无摘要、无待处理摘要），文件本身已经没有内容可恢复，
      // 删掉不损失任何东西。
      self.postMessage({ type: "memoryDeleted", chatId } satisfies AiMemoryDeletedEvent);
    }
  }
  if (skippedOverCapacity > 0) {
    logger.error(
      `Left the persisted AI memory of ${skippedOverCapacity} chat(s) on disk without hydrating it: ` +
      `the in-memory ceiling of ${AI_MEMORY_MAX_CHATS} chat(s) was already reached.`
    );
  }
}
