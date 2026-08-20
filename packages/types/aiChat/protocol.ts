import type { MediaKind, TelegramVisionSource } from "../media";
import type { AiHydrateStickerCatalogMessage, AiStickerCatalogEvent } from "../stickers/protocol";
import type { AiSpeakerSnapshot } from "./speaker";
import type { AgentDeploymentConfig } from "../config";

/** Worker 侧自我认知所需的机器人账号身份。 */
export interface AiBotInfo {
  id: number;
  username: string;
  first_name: string;
}

/** 本轮生图可选的一张 Telegram 参考图；只在触发/排队链路短期流转，不落盘。 */
export type ImageGenerationReference = TelegramVisionSource;
export type AiDirectTriggerReason = "reply" | "mention";

/**
 * AI Worker 的唯一初始化消息：机器人身份 + 主线程解析出来的 AI 对话能力快照。
 *
 * 配置随身份一起投递而不是让 Worker 自己读盘，是「同一进程内只有一代配置」的
 * 落点：这条消息在 initAiChat 里构造一次，崩溃重建时由 lastInitState 原样重放
 * （见 aiChat/workerBridge.ts），因此新 isolate 拿到的永远是进程启动那一刻的
 * 那份，改 config/agent.json 必须整进程重启才会生效。
 *
 * `agent` 里带着各能力的 api_key，只在这条消息上跨线程流动一次：不落盘、不进
 * state、不进任何事件回执，日志侧由 logger 的值级脱敏兜底（见 infra/logger.ts）。
 */
export interface AiInitMessage {
  type: "init";
  botInfo: AiBotInfo;
  /** 主线程从部署配置读取后注入；Worker 不直接加载 Telegram 配置。 */
  superAdminUserId: number;
  agent: AgentDeploymentConfig;
}

/** 主线程从 Telegram update 提取的原始回复引用；Worker 会清洗成持久化形态。 */
export interface AiReplyReference extends AiSpeakerSnapshot {
  messageId: number;
  text: string;
  /** 用户选中的精确引用片段；没有时为 undefined（形状约束见 AiSpeakerSnapshot）。 */
  quote: string | undefined;
  /** 原消息是转发时的来源标注（见 auto/message/facts.ts 的 resolveForwardOrigin）。 */
  forwardedFrom: string | undefined;
}

/**
 * 文字与媒体记录协议共用的消息身份和回复关系。
 *
 * 全部字段必填（缺省显式 undefined），且构造点必须一次写全、按声明顺序。
 * 这条协议每条 AI 群消息走一次，形状发散会同时打到主线程构造侧和 Worker
 * 的消费侧；`persistImmediately` 尤其不能沿用「用到才补一个键」的写法——
 * 事后加属性会当场把已经定型的对象改成另一个隐藏类。
 */
export interface AiRecordContext {
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  username: string | undefined;
  messageId: number;
  replyTo: AiReplyReference | undefined;
  /** 当前消息本身是转发时的来源标注；非转发为 undefined。 */
  forwardedFrom: string | undefined;
  /**
   * 主线程确认该群此前发生过 durable purge 时，要求这条记录形成的快照
   * 绕过周期上报；仅由 aiChat/messageIngress.ts 置位，Telegram 入口一律先写
   * false，不得省略该键。
   */
  persistImmediately: boolean;
}

export interface AiRecordMessage extends AiRecordContext {
  type: "record";
  text: string;
}

export interface AiRecordMediaMessage extends AiRecordContext {
  type: "recordMedia";
  kind: MediaKind;
  caption: string;
  fileId: string;
  fileUniqueId: string;
  /** 实际传给视觉管线的本体/缩略图尺寸；语音恒为 0。 */
  width: number;
  height: number;
  commentOnResolve: boolean;
  /** 当前媒体消息是否直接回复/@机器人，允许模型自行判断图片工具意图。 */
  imageGenerationRequested: boolean;
  /** 贴纸取不到视觉源时的兜底文案；其余媒体为 undefined。 */
  stickerFallbackText: string | undefined;
  /**
   * 语音专用的两项事实；其余媒体分别为 undefined 与 0。
   *
   * 摊平成两个字段而不是包一个 `voice: {...} | undefined` 对象：这条协议每条媒体
   * 消息走一次，多一个按类型才出现的嵌套对象既多一次分配，也让消费侧的读取点在
   * 「有对象」与「没对象」之间多态（形状约束见 AiRecordContext 的说明）。
   *
   * mime 是 Telegram 声明的容器，交给转写侧按白名单归一（见
   * aiChat/ai/telegramAudio.ts 的 normalizeVoiceMime）——声明值是外部输入，不原样
   * 转发进模型请求体。
   */
  voiceMime: string | undefined;
  voiceDurationSeconds: number;
  /**
   * 直接触发的成因；随机/无触发为 undefined。
   *
   * 摊平理由同上面 voiceMime/voiceDurationSeconds 那段——嵌套对象在这条每媒体
   * 消息走一次的协议上既多一次分配，也让消费侧读取点多态。实测把这一个字段
   * 从 `{ reason }` 改成字符串后，整条载荷的 structuredClone 从 9.05 µs 降到
   * 4.16 µs（Bun 1.3.14，7 个独立进程各 7 样本取中位数）。
   */
  directTriggerReason: AiDirectTriggerReason | undefined;
}

export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  isRandomTrigger: boolean;
  /** 主线程发送面高压快照；随机触发据此丢弃，直接触发据此串行生成。 */
  telegramBackpressured: boolean;
  /** 当前触发是否具备图片工具资格；具体生成/编辑意图由模型判断。 */
  imageGenerationRequested: boolean;
  /** 当前图片/贴纸，或本条文字回复的图片/贴纸；仅在直接触发的本轮短期附带。 */
  imageGenerationReference?: ImageGenerationReference;
}

export interface AiHydrateMessage {
  type: "hydrate";
  memories: Map<number, string>;
}

export interface AiFlushMemoryMessage {
  type: "flushMemory";
  flushId: number;
}

export interface AiInvalidateChatMessage {
  type: "invalidateChat";
  chatId: number;
  purgeMemory: boolean;
  requestId: number;
}

/** /switch_mood 的重抽请求：未过 deadlineAt 时 Worker 调 aiChat/ai/mood.ts 的
 *  switchMood，再以同 requestId 的 moodSwitched 回执带回结果；过期请求
 *  不得产生副作用，回复由主线程命令处理器发出。 */
export interface AiSwitchMoodMessage {
  type: "switchMood";
  chatId: number;
  /** 主线程分配的单调递增回执关联 id（见 cache/main/aiChat.ts 的 moodRequestCounter）。 */
  requestId: number;
  /** 请求的绝对截止时刻；Worker 收到时已过期则不得再改写群心情。 */
  deadlineAt: number;
}

/** /query_mood 的查询请求：未过 deadlineAt 时 Worker 读取本群当前有效心情，
 * 再以同 requestId 的 moodQueried 回执带回结果；不得强制重抽未到期心情。 */
export interface AiQueryMoodMessage {
  type: "queryMood";
  chatId: number;
  /** 主线程分配的单调递增回执关联 id（与 switchMood 共用编号空间）。 */
  requestId: number;
  /** 请求的绝对截止时刻；Worker 收到时已过期则不再查询。 */
  deadlineAt: number;
}

export type AiChatWorkerMessage =
  | AiInitMessage
  | AiRecordMessage
  | AiRecordMediaMessage
  | AiTriggerMessage
  | AiHydrateMessage
  | AiHydrateStickerCatalogMessage
  | AiFlushMemoryMessage
  | AiInvalidateChatMessage
  | AiQueryMoodMessage
  | AiSwitchMoodMessage;

export interface AiSentMessage {
  type: "sent";
  chatId: number;
  messageId: number;
}

export interface AiMemoryEvent {
  type: "memory";
  chatId: number;
  snapshot: string;
  /** purge 后首份新快照；主线程须要求 Disk I/O 立即写盘并等待 revision 回执。 */
  persistImmediately?: boolean;
}

export interface AiMemoryDeletedEvent {
  type: "memoryDeleted";
  chatId: number;
}

export interface AiMemoryFlushedEvent {
  type: "memoryFlushed";
  flushId: number;
}

/** Worker -> 主线程：旧 generation 的用户可见副作用已经全部收敛。 */
export interface AiChatInvalidatedEvent {
  type: "chatInvalidated";
  chatId: number;
  requestId: number;
}

/** switchMood 请求的回执：带回重抽结果，主线程凭 requestId 结算等待者。 */
export interface AiMoodSwitchedEvent {
  type: "moodSwitched";
  chatId: number;
  requestId: number;
  /** 新抽中的心情档位名（config/mood.json 的 name 字段）。 */
  moodName: string;
}

/** queryMood 请求的回执：带回当前有效心情，主线程凭 requestId 结算等待者。 */
export interface AiMoodQueriedEvent {
  type: "moodQueried";
  chatId: number;
  requestId: number;
  /** 当前有效心情档位名（config/mood.json 的 name 字段）。 */
  moodName: string;
}

export type AiChatWorkerEvent =
  | AiSentMessage
  | AiMemoryEvent
  | AiMemoryDeletedEvent
  | AiMemoryFlushedEvent
  | AiChatInvalidatedEvent
  | AiMoodQueriedEvent
  | AiMoodSwitchedEvent
  | AiStickerCatalogEvent;
