import type { BufferedMessage } from "./aiChatWorker";

/** Worker 侧自我认知所需的机器人账号身份（bot.init() 之后才可得，见 initAiChat）。 */
export interface AiBotInfo {
  id: number;
  username: string;
  first_name: string;
}

/** 主线程 -> Worker：注入机器人账号身份（必须先于一切 trigger 送达）。 */
export interface AiInitMessage {
  type: "init";
  botInfo: AiBotInfo;
}

/** 主线程 -> Worker：把一条群消息记入该群的滚动对话缓存。 */
export interface AiRecordMessage {
  type: "record";
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  text: string;
}

/** 主线程 -> Worker：把一条图片消息记入滚动缓存——先占位、异步解析出描述后
 * 原位回填，见 workers/aiChatWorker.ts 的 recordChatImage。相册是多条消息
 * 各带一张图，天然逐条投递。 */
export interface AiRecordImageMessage {
  type: "recordImage";
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  /** 图片自带的配文（没有则空串），跟在描述/占位标签后入转录行。 */
  caption: string;
  /** 已按大小挑好档位的 photo file_id（见 auto/message.ts 的 pickPhotoFileId）。 */
  fileId: string;
}

/** 主线程 -> Worker：触发一次 AI 回复（冷却/限频判定也在 Worker 侧做）。 */
export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  replyToMessageId: number;
  repliedBotText?: string;
  isRandomTrigger: boolean;
}

/**
 * 某个群的 AI 记忆快照：滚动缓存 + 中期摘要队列，落盘结构见
 * memory/ai/<chatId>.json（src/workers/diskIO/snapshotFiles.ts）。由
 * aiChatWorker 定期序列化 dirty 群上报（见 workers/aiChatWorker.ts 的
 * flushDirtyMemories），经主线程 aiChat.ts 转投 diskIOWorker 落盘。
 */
export interface AiMemorySnapshot {
  version: 1;
  /** 逐字滚动缓存，上限见 consts/aiChat.ts 的 VERBATIM_CONTEXT_MAX。 */
  buffer: BufferedMessage[];
  /** 中期记忆队列，从旧到新，上限见 consts/aiChat.ts 的 MAX_SUMMARY_ROUNDS。 */
  summaries: string[];
  /** 待晋升的镜像摘要；无则为 null。 */
  pendingSummary: string | null;
  /** 快照生成时刻（毫秒时间戳），排查用。 */
  savedAt: number;
}

/**
 * 主线程 -> Worker：启动时（或本 Worker 崩溃重启后）灌入持久化的记忆快照。
 * 必须紧跟在 init 之后、任何 record/trigger 之前送达（FIFO 保证顺序）。
 * 只对内存里还没有数据的群生效——重启后本来就全空，天然成立。
 */
export interface AiHydrateMessage {
  type: "hydrate";
  memories: Map<number, AiMemorySnapshot>;
}

/** 主线程 -> Worker：退出前最后一刷，立即把所有 dirty 群的快照 post 出去，随后回执。 */
export interface AiFlushMemoryMessage {
  type: "flushMemory";
  flushId: number;
}

export type AiChatWorkerMessage = AiInitMessage | AiRecordMessage | AiRecordImageMessage | AiTriggerMessage | AiHydrateMessage | AiFlushMemoryMessage;

/**
 * Worker -> 主线程：一条消息已经发出去了（AI 回复或跟发的贴纸）。Worker
 * 用的是自己线程内独立的 grammY Api 客户端，主线程的自动流水线认不出
 * 那次发送——报回来让主线程登记进 infra/selfSentTracker.ts，识别出「频道
 * 自回环」并整体跳过，不然会被自己的随机回复再触发一轮（见 auto/message.ts）。
 */
export interface AiSentMessage {
  type: "sent";
  chatId: number;
  messageId: number;
}

/** Worker -> 主线程：一个群的记忆快照（dirty 群定时上报，或 flushMemory 触发的即时上报）。 */
export interface AiMemoryEvent {
  type: "memory";
  chatId: number;
  snapshot: AiMemorySnapshot;
}

/** Worker -> 主线程：flushMemory 已完成（所有 dirty 群快照都已 post 出）。 */
export interface AiMemoryFlushedEvent {
  type: "memoryFlushed";
  flushId: number;
}

export type AiChatWorkerEvent = AiSentMessage | AiMemoryEvent | AiMemoryFlushedEvent;
