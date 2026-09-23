import type { Atmosphere } from "../atmosphere";
import type { MediaKind, TelegramVisionSource } from "../media";
import type { AiHydrateStickerCatalogMessage, AiStickerCatalogEvent } from "../stickers/protocol";
import type { AiMemoryUsage } from "./memory";
import type { AiSpeakerSnapshot } from "./speaker";
import type {
  AgentDeploymentConfig,
  MoodConfig,
  StickerConfig,
} from "../config";

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
 * AI Worker 初始化消息：机器人身份 + 主线程解析的 AI 对话能力快照。
 * startAiChatWorker 构造消息，syncAiChatConfig 在热重载时更新 lastInitState；Worker
 * 崩溃重建时重放当前快照，Worker 不自行读取部署配置（见 aiChat/workerBridge.ts）。
 *
 * `agent` 的 api_key 随 init 与 configReload 由主线程传给 AI Worker，重建时会重放；
 * 不写入运行时状态或事件回执。凭据与日志脱敏约束见 docs/cn/04-invariants.md。
 */
export interface AiInitMessage {
  type: "init";
  botInfo: AiBotInfo;
  /** 主线程从 config/bot.json 读取后注入；Worker 不直接加载 Bot 部署配置。 */
  superAdminUserId: number;
  defaultAtmosphere: Atmosphere;
  agent: AgentDeploymentConfig;
  mood: MoodConfig;
  stickers: StickerConfig;
  persona: string;
}

/**
 * config/ 热重载后主线程已生效的 AI 部署配置（见 app/configReload.ts）。字段为
 * undefined 表示该领域本轮未变化；主线程在投递前同步改写 lastInitState，Worker
 * 重建时由 init 重放同一份最新快照。`agent` 带凭据，传输与脱敏约束同 AiInitMessage。
 */
export interface AiConfigReloadMessage {
  type: "configReload";
  agent: AgentDeploymentConfig | undefined;
  mood: MoodConfig | undefined;
  stickers: StickerConfig | undefined;
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
 * 全部字段必填（缺省显式 undefined），且构造点必须一次写全、按声明顺序（热路径
 * 对象形状约束见 docs/cn/04-invariants.md）；`persistImmediately` 同样不得省略。
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
  /**
   * 本条媒体要发起回复轮时的 Telegram 发送面高压快照；不发起回复为 undefined。
   *
   * 发起回复指直接触发，或非直接触发但已占到随机评价名额（解析完成后评价），
   * 直接触发恒为 boolean。Worker 以是否为 undefined 决定是否进入回复准入，以取值
   * 决定随机评价丢弃与同群并发上限（见 workers/aiChat/mediaIngest.ts）；不要再增加
   * 表达「是否评价」的重复字段。
   *
   * 构造值由 auto/message/recordContext.ts 的 mediaReplyBackpressurePlaceholder 给出
   * （要回复的媒体先写 false），aiChat/messageIngress.ts 在投递时刻覆写为与 trigger
   * 消息同源的快照；键恒发。
   */
  replyTelegramBackpressured: boolean | undefined;
  /** 贴纸取不到视觉源时的兜底文案；其余媒体为 undefined。 */
  stickerFallbackText: string | undefined;
  /**
   * 语音专用的两项事实，摊平为两个字段而非嵌套对象；其余媒体分别为 undefined
   * 与 0。mime 为 Telegram 声明的容器原始值，交给转写侧按白名单归一（见
   * aiChat/ai/telegramAudio.ts 的 normalizeVoiceMime）后才可用于模型请求。
   */
  voiceMime: string | undefined;
  voiceDurationSeconds: number;
  /**
   * 直接触发的成因；随机/无触发为 undefined。它同时就是「本轮有没有图片工具
   * 资格」这一个事实，不要增加重复布尔字段；四个 handler 与
   * workers/aiChat/mediaIngest.ts 都以是否为 undefined 判断。
   */
  directTriggerReason: AiDirectTriggerReason | undefined;
  /**
   * 触发消息所在的论坛话题 id；General、非论坛群与讨论组评论为 undefined。
   *
   * 媒体轮的回复由 Worker 在 describeMedia 解析完成后异步发起，那时手上只剩这条
   * 载荷，因此话题落点必须随它一起过线（见 workers/aiChat/mediaIngest.ts）。判定
   * 与提取见 libs/forumTopic.ts。键恒发、缺省显式 undefined，不得省略。
   */
  messageThreadId: number | undefined;
}

export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  isRandomTrigger: boolean;
  /**
   * 主线程发送面高压快照；随机触发据此丢弃，直接触发据此串行生成。判定与
   * AiRecordMediaMessage.replyTelegramBackpressured 同源（见 aiChat/messageIngress.ts）。
   */
  telegramBackpressured: boolean;
  /** 当前触发是否具备图片工具资格；具体生成/编辑意图由模型判断。 */
  imageGenerationRequested: boolean;
  /** 当前图片/贴纸，或本条文字回复的图片/贴纸；仅在直接触发的本轮短期附带。 */
  imageGenerationReference?: ImageGenerationReference;
  /**
   * 本群已登记的问答（问题原文 -> 答案）；本群一条都没有时省略。
   *
   * 挂在这条已有消息上而不是另建一份 Worker 镜像：接收方所需的最终字段放进
   * 现有消息，就不必为它维护推送时机、全量/增量模式和 Worker 重启后的重放方
   * （见 AGENTS.md 的「缓存与线程归属」）。载荷有界——每群至多 CHAT_QA_MAX_PER_CHAT 条。
   *
   * 一字不差的提问不会走到这里：那种情况在主干上就被直答短路了，连 trigger
   * 都不会发。到得了 Worker 的只有「意思像但字面不同」，交给模型判断。
   */
  chatQa?: ReadonlyMap<string, string>;
  /**
   * 触发消息所在的论坛话题 id；General、非论坛群与讨论组评论为 undefined。
   *
   * 本轮全部主动发送（文字、贴纸、生图、生歌、「正在输入…」与限频提示）都要带上
   * 它，否则话题群里除「挂了回复」之外的每一条都会掉进 General。判定与提取见
   * libs/forumTopic.ts。键恒发、缺省显式 undefined，不得省略。
   */
  messageThreadId: number | undefined;
}

/** 主线程群状态变更的人设最终值；null 表示恢复默认提示词。 */
export interface AiPersonaMessage {
  type: "persona";
  chatId: number;
  persona: string | null;
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
  requestId: number;
}

/** /mood switch 的重抽请求：未过 deadlineAt 时 Worker 调 aiChat/ai/mood.ts 的
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

/** /mood query 的查询请求：未过 deadlineAt 时 Worker 读取本群当前有效心情，
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
  | AiPersonaMessage
  | AiInitMessage
  | AiConfigReloadMessage
  | AiRecordMessage
  | AiRecordMediaMessage
  | AiTriggerMessage
  | AiHydrateMessage
  | AiHydrateStickerCatalogMessage
  | AiFlushMemoryMessage
  | AiInvalidateChatMessage
  | AiQueryMoodMessage
  | AiSwitchMoodMessage;

export interface AiMemoryEvent {
  type: "memory";
  chatId: number;
  snapshot: string;
  /** purge 后首份新快照；主线程须要求 Disk I/O 立即写盘并等待 revision 回执。 */
  persistImmediately?: boolean;
  /**
   * 本群此刻的上下文占用量，供主线程的只读镜像展示（见 cache/main/aiChat.ts 的
   * aiMemoryUsages）。
   *
   * 挂在这条已有事件上而不是另起一路上报：接收方所需的最终字段放进现有消息，
   * 就不必为它单独维护推送时机（见 AGENTS.md 的「缓存与线程归属」）。这里用
   * 一个对象而不是摊平成两个数字——本事件每群每 AI_SNAPSHOT_INTERVAL_MS 才走
   * 一次，不在任何逐条消息的热路径上，而接收侧原样存进镜像、不再重建对象。
   */
  usage: AiMemoryUsage;
}

/**
 * hydrate 完成后一次性回传各群的上下文占用量，用于播种主线程镜像。
 *
 * 启动恢复与 Worker 崩溃重建走的都是 hydrate（重建时由 aiChat/workerBridge.ts 的
 * onRespawn 重放），恢复出来的群在下一条新消息之前不 dirty、不会产生 memory
 * 事件；没有这条事件，那些群的占用量要一直缺到它们重新说话为止。
 */
export interface AiMemoryUsagesEvent {
  type: "memoryUsages";
  usages: Map<number, AiMemoryUsage>;
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
  | AiMemoryEvent
  | AiMemoryUsagesEvent
  | AiMemoryDeletedEvent
  | AiMemoryFlushedEvent
  | AiChatInvalidatedEvent
  | AiMoodQueriedEvent
  | AiMoodSwitchedEvent
  | AiStickerCatalogEvent;
