/** 广告检测流水线的跨线程协议与 Worker 内部纯数据形状。 */
import type { Chat, Message } from "grammy/types";
import type { TelegramIdentityMetadata } from "../identityPolicy";

/**
 * 同一条群消息的广告累计与候选构建共用事实；构造后保持固定 shape。只为通过
 * antiRaid/adCandidate.ts 的 adDetectionSenderId 前置判定的消息构造。
 */
export interface AdDetectionMessageContext {
  readonly message: Message;
  readonly botId: number;
  readonly now: number;
  /** adDetectionSenderId 判出的展示身份 id（频道马甲优先，否则 from.id）。 */
  readonly senderId: number;
  /** 消息的可见频道身份（见 users/visibleSender.ts）；普通用户发言为 undefined。 */
  readonly senderChat: Chat | undefined;
}

/**
 * 广告检测向任一 provider 发送的中立结构化请求。模型与采样预算属于判定领域，
 * 传输实现只把这些语义映射到各自 SDK。
 */
export interface AdDetectJsonRequestParams {
  /** 模型名来自 config/dynamic/agent.json 的 agent.ad_detect。 */
  readonly model: string;
  /** 判定规则与部署示例段，不含系统事实；Gemini 路径的系统指令，也是它显式缓存的内容。 */
  readonly instructions: string;
  /** 本次的系统事实一行；Gemini 路径把它作为 user 轮里排在 userContent 之前的独立 part。 */
  readonly fact: string;
  /**
   * instructions、换行与 fact 拼成的完整系统提示词；OpenAI 兼容路径的 system 段。
   * OpenAI JSON 模式要求其中出现 json。
   */
  readonly systemPrompt: string;
  /** 本次待处理的用户内容；一律当数据，不承担指令语义。 */
  readonly userContent: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** 出现在错误日志里的调用名（英文）。 */
  readonly errorLabel: string;
}

/**
 * 按当前广告示例快照拼好的判定提示词（见 cache/workers/antiRaid/adDetect.ts）。
 * 各系统提示词共用同一份 instructions 前缀；系统提示词 = instructions + 换行 + 对应的系统事实。
 */
export interface AdDetectPrompts {
  /** 判定规则与部署示例段，不含系统事实。 */
  readonly instructions: string;
  /** 发送者仍在入群验证窗口内时的完整系统提示词。 */
  readonly justJoinedSystemPrompt: string;
  /** 发送者不在入群验证窗口内时的完整系统提示词。 */
  readonly establishedSystemPrompt: string;
}

/** 参与判定、同时写进命中样本的上下文。两项都可能缺席。 */
export interface AdSampleContext {
  /** 这条消息里被引用的那一段（message.quote）。 */
  quote?: string;
  /** 这条消息回复的那条原消息的正文。 */
  replyTo?: string;
}

/**
 * 主线程 -> Worker：一条待广告判定的群消息。只有本群开了 /ad_detect enable、
 * 机器人是本群管理员、且发送者不是自己人时才投递（见 antiRaid/adCandidate.ts）。
 * Worker 侧按发送者归并成消息串排队送检，见 workers/antiRaid/adDetect/queue.ts。
 *
 * 字段全部必填、缺省显式 undefined，除 linkUrls 外只含原始值；发送者元数据与引用
 * 上下文平铺成独立字段，Worker 侧按需重新组装。
 */
export interface AdCandidateMessage {
  type: "adCandidate";
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  messageId: number;
  /**
   * 主线程观测到这条 update 的时刻，本条消息在 Worker 侧的全部时间判定都用它。
   *
   * 由主线程按 update 唯一的那次时钟读取填入（见 infra/updateContext.ts 的
   * updateNow），Worker 不为每条候选再读墙钟。它是主线程收到这条消息的时刻，
   * 不是 Worker 从 mailbox 取到它的时刻。
   */
  observedAt: number;
  /** 已清洗成单行的正文（文本或图片说明）。 */
  text: string;
  /**
   * Telegram 展示元数据（口径同 TelegramIdentityMetadata）；用户的 firstName、lastName
   * 同时参与当次广告检测。
   */
  firstName: string;
  lastName: string;
  username: string;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /** 当前消息是手工转发；其 text/caption 归属于 forward_origin，而非转发者本人。 */
  isForwarded: boolean;
  /** 发送者此刻是否已经在永久黑名单里。 */
  blocked: boolean;
  /** 发送者此刻是否仍在入群验证窗口内。 */
  justJoined: boolean;
  /** 正文里不可见的 text_link 落地页 URL；没有时为 undefined。 */
  linkUrls: string[] | undefined;
  /**
   * 被引用段与被回复原文（口径同 AdSampleContext 的 quote 与 replyTo）；与 text 一起
   * 参与判定并留进命中样本，缺席时为 undefined。
   */
  sampleQuote: string | undefined;
  sampleReplyTo: string | undefined;
}

/** 主线程 -> Worker：丢掉这个群尚未送检的广告判定队列。 */
export interface ClearAdDetectMessage {
  type: "clearAdDetect";
  chatId: number;
}

/** 命中样本里的一条消息：判定读到的内容，以及单独保留的引用上下文。 */
export interface AdSampleMessage extends AdSampleContext {
  messageId: number;
  /** 送检时的内容（当次用户姓名、已截断正文与 text_link 落地页），与模型读到的完全一致。 */
  text: string;
}

/** Worker -> 主线程：发送者被判成广告，请按 /block 同样的处置办。 */
export interface AdDetectedEvent {
  type: "adDetected";
  chatId: number;
  senderId: number;
  isChannel: boolean;
  /** 处置播报里的展示标签，Worker 按 meta 与本进程氛围算好。 */
  label: string;
  meta: Readonly<TelegramIdentityMetadata>;
  /** 模型给出的简短理由，只进日志、播报与命中样本；不参与控制流。 */
  reason: string;
  /** 本次判定依据的完整消息串。 */
  messages: readonly AdSampleMessage[];
}

/** 一条参与广告判定的消息。 */
export interface AdCandidateEntry extends AdSampleContext {
  messageId: number;
  /** 本串内单调递增的序号，判定进度按它记账（见 AdMessageBundle.checkedSeq）。 */
  seq: number;
  /** 当次用户姓名与已限长的正文、落地页、引用上下文；参与整串送检预算。 */
  text: string;
  /** 当前发送者本人的姓名与正文；转发消息只保留转发者姓名，用于直接广告归因。 */
  directText: string;
  /**
   * 主线程观测时刻（入队时的 now，缺省即 AdCandidateMessage.observedAt）；用于回收
   * 去重窗口外已经消费过的上下文与冻结引用广告警告窗口；处置抑制另用 Worker 单调时钟。
   */
  receivedAt: number;
  /**
   * 本条到达时是否处于已经公开的引用广告警告窗口；该事实在入队时冻结，不用之后的
   * 处理墙钟重新推断。
   */
  withinReferencedWarning: boolean;
}

/** 每个群内发送者的引用广告警告阶段。 */
export type ReferencedAdWarningState =
  | {
    readonly phase: "sending";
    /** 同 key 的单调 attempt；清群后迟到的旧回执不命中新状态。 */
    readonly generation: number;
  }
  | {
    readonly phase: "warned";
    readonly generation: number;
    readonly warnedAt: number;
    readonly expiresAt: number;
  };

/** 某个发言者在一个群里累积的待检消息串（队列里只排它的键）。 */
export interface AdMessageBundle {
  /**
   * 本串的 `chatId:senderId` 键（verificationKey），建串时算一次；队列、在途、处置抑制与
   * 引用警告几张表都以它为键，同一发送者的后续消息直接取用、不重新拼键。
   */
  readonly key: string;
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  /**
   * 随候选冻结并在昵称变化时更新，用于主线程最终写入黑名单；处置播报的展示标签也由它
   * 现算（见 workers/antiRaid/adDetect/disposal.ts 的 adSenderLabel）。
   */
  meta: Readonly<TelegramIdentityMetadata>;
  /**
   * 送检姓名（workers/antiRaid/adDetect/senderName.ts 的 formatAdSenderName），建串时算出，
   * meta 的姓或名变化时随之重算；频道马甲恒为空串。
   */
  senderName: string;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /**
   * 这一串里是否有任何一条是「刚进群、还没通过验证」时发出的；取并集，不取最后一条。
   */
  justJoined: boolean;
  entries: AdCandidateEntry[];
  /**
   * 被单 key 条数上限挤出 entries、却从来没送过判定的消息 id；命中后并入处置的删除集合
   * （见 workers/antiRaid/adDetect/disposal.ts）。容量见 AD_DETECT_MAX_PENDING_DELETE_IDS。
   */
  pendingDeleteIds: number[];
  /**
   * 这一串已经因为待删列表撑满而丢过 id；该行错误日志每个发送者最多记一次。建串时为 false。
   */
  pendingDeleteOverflowed: boolean;
  /**
   * 这一串已经因为单 key 条数上限挤掉过从没判定过的正文；该行错误日志每个发送者最多
   * 记一次。建串时为 false。
   */
  uncheckedEvicted: boolean;
  /** 下一条消息要用的序号；只增不减，上下文裁剪不回退它。 */
  nextSeq: number;
  /**
   * 已送检过的最大序号；只有序号比它大的消息才重新入队。按序号记账，不按 entries 的
   * 数组下标。
   */
  checkedSeq: number;
}

/** 一次广告判定的结果；请求失败时调用方拿到 null，不做任何处置。 */
export interface AdVerdict {
  isAd: boolean;
  reason: string;
}

/** Worker -> 主线程：模型明确返回 ad=true；用于清空连续合格日累计。 */
export interface AdVerdictTrueEvent {
  type: "adVerdictTrue";
  chatId: number;
  senderId: number;
}

/** 广告判定流水线向主线程发布的完整事件。 */
export type AdDetectionEvent = AdVerdictTrueEvent | AdDetectedEvent;

/** 一次广告消息串送检的取舍结果。 */
export interface AdBundleSelection {
  /** 本次真正交给模型的条目，按时间先后排列（已判上下文在前，未判内容在后）。 */
  entries: AdCandidateEntry[];
  /** 本次判到的最新未判条目序号；整串都已判过时等于 bundle.checkedSeq。 */
  checkedToSeq: number;
}
