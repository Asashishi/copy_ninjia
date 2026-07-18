import type { BufferedMessage } from "./aiChatWorker";
import type { MediaKind } from "./media";

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
  /** Telegram 公开 username（不含 @）；没有公开 username 时省略。 */
  username?: string;
  text: string;
}

/** 主线程 -> Worker：把一条图片/贴纸/GIF 消息记入滚动缓存——先占位、异步
 * 解析出描述后原位回填，见 workers/aiChatWorker.ts 的 recordChatMedia。
 * 相册是多条消息各带一张图，天然逐条投递。 */
export interface AiRecordMediaMessage {
  type: "recordMedia";
  /** 媒体类型，决定占位符/视觉提示词/描述长度上限，见 ai/imageDescription.ts
   * 的 describeMedia。 */
  kind: MediaKind;
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  /** Telegram 公开 username（不含 @）；没有公开 username 时省略。 */
  username?: string;
  /** 媒体自带的配文（没有则空串），跟在描述/占位标签后入转录行。 */
  caption: string;
  /** 要下载的 Telegram file_id：图片是已按大小挑好档位的 photo file_id
   * （见 auto/message.ts 的 pickPhotoFile）；贴纸/GIF 是本体或缩略图（见
   * ai/stickerSets.ts 的 pickStickerVisionSource、auto/message.ts 的
   * animation 分支），素材选择已在主线程完成。 */
  fileId: string;
  /** 描述查找/临时去重缓存的键：图片用同档位的 file_unique_id；贴纸/GIF
   * 固定用媒体自身（而非缩略图）的 file_unique_id。白名单贴纸先用它命中
   * 常驻 stickerCatalog，未命中才作为 describeMedia 的临时缓存键。 */
  fileUniqueId: string;
  /** 这条消息本身的 message_id，评图/评贴纸/评 GIF 回复要用它挂 Telegram
   * 回复引用。 */
  messageId: number;
  /** 主线程已掷中「解析完成后评价这份媒体」（概率见 AI_REPLY_PROBABILITY，
   * 与文字随机搭话共用同一个概率，已照顾 /quiet 与随机回复冷却）；Worker
   * 在描述解析成功时执行评价回复。 */
  commentOnResolve: boolean;
  /** kind === "sticker" 时视觉解析失败的兜底文本（现有元数据行，见
   * ai/stickerSets.ts 的 describeStickerForContext）——即便解析失败也不
   * 丢失贴纸自带的 emoji/包名信息；其余 kind 不传。 */
  stickerFallbackText?: string;
  /** 这份媒体是在明确跟机器人说话（回复机器人，或 caption 里 @ 机器人）：
   * 描述就绪后必触发一次直接回复——先试常驻贴纸目录/临时描述缓存，未命中
   * 就等异步解析完成再触发，解析失败也用兜底文本回，真人在等回应、不能
   * 静默失踪。不掷概率、不受 /quiet 影响，与 commentOnResolve 互斥（主线程
   * 只会设其一）。 */
  directTrigger?: {
    reason: "reply" | "mention";
    /** 被回复的那条机器人消息文本（机器人消息不在缓存里）；机器人那条
     * 若是贴纸等非文本消息、或本次是 @ 提及时则缺省。 */
    repliedBotText?: string;
  };
}

/** 单枚贴纸的目录条目：emoji 元数据 + AI 生成的画面描述（≤100 字，见
 * consts/aiChat.ts 的 SHORT_MEDIA_DESCRIPTION_MAX_CHARS）。 */
export interface StickerCatalogEntry {
  emoji: string;
  description: string;
}

/**
 * 某个白名单贴纸包的目录快照：贴纸自身 file_unique_id -> 目录条目。落盘
 * 结构见 memory/stickers/<pack>.json（src/workers/diskIO/snapshotFiles.ts）。
 * 由 ai/stickerCatalog.ts 在 Worker 侧生成、aiChatWorker.ts 定期上报 dirty
 * 包，经主线程 aiChat.ts 转投 diskIOWorker 落盘。
 */
export interface StickerCatalogSnapshot {
  version: 1;
  entries: Record<string, StickerCatalogEntry>;
  /** AI 生成的整包简介（≤200 字，见 consts/aiChat.ts 的
   * STICKER_PACK_SUMMARY_MAX_CHARS），供两层贴纸工具的第一层挑包；还没生成
   * 出来为 null，下次对账时会补生成。 */
  summary: string | null;
  savedAt: number;
}

/**
 * 主线程 -> Worker：启动时（或本 Worker 崩溃重启后）灌入持久化的贴纸目录。
 * 必须紧跟在 init 之后送达（FIFO），让 ensureStickerCatalogs 的 diff 生成
 * 能看到已恢复的条目、不重复调视觉模型。只对内存里还没有数据的包生效。
 * 值是 StickerCatalogSnapshot 的序列化 JSON（快照在整条管线上以字符串
 * 形态流转，理由见 AiMemoryEvent.snapshot），由 hydrateStickerCatalogs
 * 解析回结构。
 */
export interface AiHydrateStickerCatalogMessage {
  type: "hydrateStickerCatalog";
  catalogs: Map<string, string>;
}

/** 主线程 -> Worker：触发一次 AI 回复（同群并发占位与限频判定都在 Worker 侧做）。 */
export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  replyToMessageId: number;
  repliedBotText?: string;
  /** 是否是随机插话触发：怎么接、挂不挂回复引用由模型判断，但必须回应
   *  （说话/贴纸/扣反应都算）、不允许沉默（见 workers/aiChatWorker.ts 的
   *  generateAndSendReply）。 */
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
 * 值是 AiMemorySnapshot 的序列化 JSON（见 AiMemoryEvent.snapshot），由
 * hydrateMemories 解析回结构。
 */
export interface AiHydrateMessage {
  type: "hydrate";
  memories: Map<number, string>;
}

/** 主线程 -> Worker：退出前最后一刷，立即把所有 dirty 群的快照 post 出去，随后回执。 */
export interface AiFlushMemoryMessage {
  type: "flushMemory";
  flushId: number;
}

/** 主线程 -> Worker：使某群当前代数失效并清空等候队列。在途网络请求无法
 *  物理取消，但响应返回后的发送、工具和记忆回填均受代数检查拦截。 */
export interface AiInvalidateChatMessage {
  type: "invalidateChat";
  chatId: number;
  /** 同时清除内存、主线程镜像及磁盘快照。 */
  purgeMemory: boolean;
}

export type AiChatWorkerMessage =
  | AiInitMessage
  | AiRecordMessage
  | AiRecordMediaMessage
  | AiTriggerMessage
  | AiHydrateMessage
  | AiHydrateStickerCatalogMessage
  | AiFlushMemoryMessage
  | AiInvalidateChatMessage;

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

/** Worker -> 主线程：一个群的记忆快照（dirty 群定时上报，或 flushMemory
 * 触发的即时上报）。snapshot 是 AiMemorySnapshot 在源头（Worker 侧
 * buildMemorySnapshot）一次性 stringify 出的 JSON 文本，此后全程以字符串
 * 流转：postMessage 克隆字符串近乎 memcpy（对象图则要走两跳深克隆——
 * Worker -> 主线程 -> diskIOWorker），落盘端直接原样写文件、零重复序列化；
 * 只有启动/崩溃重放的 hydrate 才解析一次。缩进固定 2 空格，与磁盘上
 * memory/ai/<chatId>.json 的历史格式逐字节一致。
 */
export interface AiMemoryEvent {
  type: "memory";
  chatId: number;
  snapshot: string;
}

/** Worker -> 主线程：某群记忆已因显式禁用或容量淘汰在 Worker 内清除。 */
export interface AiMemoryDeletedEvent {
  type: "memoryDeleted";
  chatId: number;
}

/** Worker -> 主线程：flushMemory 已完成（所有 dirty 群快照都已 post 出）。 */
export interface AiMemoryFlushedEvent {
  type: "memoryFlushed";
  flushId: number;
}

/** Worker -> 主线程：一个白名单贴纸包的目录快照（dirty 包定时上报，或
 * flushMemory 触发的即时上报，见 ai/stickerCatalog.ts 的
 * flushDirtyStickerCatalogs）。snapshot 是 StickerCatalogSnapshot 序列化后
 * 的 JSON 文本，理由与格式约定同 AiMemoryEvent.snapshot。 */
export interface AiStickerCatalogEvent {
  type: "stickerCatalog";
  pack: string;
  snapshot: string;
}

export type AiChatWorkerEvent = AiSentMessage | AiMemoryEvent | AiMemoryDeletedEvent | AiMemoryFlushedEvent | AiStickerCatalogEvent;
