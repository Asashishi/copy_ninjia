/** 广告检测流水线的跨线程协议与 Worker 内部纯数据形状。 */
import type { Message } from "grammy/types";
import type { ChatState } from "../chatState";
import type { TelegramIdentityMetadata } from "../identityPolicy";

/** 同一条群消息的广告累计与候选构建共用事实；构造后保持固定 shape。 */
export interface AdDetectionMessageContext {
  readonly message: Message;
  readonly botId: number;
  readonly chatState: Readonly<ChatState>;
  readonly now: number;
}

/**
 * 广告检测向任一 provider 发送的中立结构化请求。模型与采样预算属于判定领域，
 * 传输实现只把这些语义映射到各自 SDK。
 */
export interface AdDetectJsonRequestParams {
  /** 模型名来自 config/agent.json 的 agent.ad_detect。 */
  readonly model: string;
  /** 系统提示词；OpenAI JSON 模式要求其中出现 json。 */
  readonly systemPrompt: string;
  /** 本次待处理的用户内容；一律当数据，不承担指令语义。 */
  readonly userContent: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** 出现在错误日志里的调用名（英文）。 */
  readonly errorLabel: string;
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
 */
export interface AdCandidateMessage {
  type: "adCandidate";
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  messageId: number;
  /** 已清洗成单行的正文（文本或图片说明）。 */
  text: string;
  /** 被引用段与被回复原文；与 text 一起参与判定并留进命中样本。 */
  sampleContext?: AdSampleContext;
  /** 正文里不可见的 text_link 落地页 URL。 */
  linkUrls?: string[];
  /** 处置播报里的展示标签，由主线程按可见发送者算好。 */
  label: string;
  /** 拉黑落库需要的 Telegram 展示元数据。 */
  meta: Readonly<TelegramIdentityMetadata>;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /** 当前消息是手工转发；其 text/caption 归属于 forward_origin，而非转发者本人。 */
  isForwarded: boolean;
  /** 发送者此刻是否已经在永久黑名单里。 */
  blocked: boolean;
  /** 发送者此刻是否仍在入群验证窗口内。 */
  justJoined: boolean;
}

/** 主线程 -> Worker：丢掉这个群尚未送检的广告判定队列。 */
export interface ClearAdDetectMessage {
  type: "clearAdDetect";
  chatId: number;
}

/** 命中样本里的一条消息：判定读到的正文，以及只给人看的上下文。 */
export interface AdSampleMessage extends AdSampleContext {
  messageId: number;
  /** 送检时的正文（已截断、已补上 text_link 落地页），与模型读到的完全一致。 */
  text: string;
}

/** Worker -> 主线程：发送者被判成广告，请按 /block 同样的处置办。 */
export interface AdDetectedEvent {
  type: "adDetected";
  chatId: number;
  senderId: number;
  isChannel: boolean;
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
  /** 已按 AD_DETECT_MESSAGE_MAX_CHARS 截断的正文（文本或图片说明）。 */
  text: string;
  /** 只含当前发送者本人写下的内容；用于命中后区分直接广告与引用类广告。 */
  directText: string;
  /** Worker 观测时刻；只用于回收去重窗口外已经消费过的上下文。 */
  receivedAt: number;
  /**
   * 本条到达时是否处于已经公开的引用广告警告窗口。判定可能排队超过五分钟，
   * 因此升级事实必须在入队时冻结，不能用之后的处理墙钟重新推断。
   */
  withinReferencedWarning: boolean;
}

/** 每个群内发送者的引用广告警告阶段。 */
export type ReferencedAdWarningState =
  | {
    readonly phase: "sending";
    /** 同 key 的单调 attempt，清群后迟到的旧回执不能命中新状态。 */
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
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  /** 处置播报里的展示标签，由主线程按可见发送者算好。 */
  label: string;
  /** 随候选冻结并在昵称变化时更新，用于主线程最终写入黑名单。 */
  meta: Readonly<TelegramIdentityMetadata>;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /**
   * 这一串里是否有任何一条是「刚进群、还没通过验证」时发出的。取并集而不是取
   * 最后一条：验证会在窗口内通过，先发广告后通过验证的人不该因此洗白。
   */
  justJoined: boolean;
  entries: AdCandidateEntry[];
  /**
   * 被单 key 条数上限挤出 entries、却从来没送过判定的消息 id。
   *
   * 判定依据（judged）与此刻串里还剩的（entries）都覆盖不到它们，不单独留一份
   * 的话，这些消息既进不了判定也进不了处置的删除集合，命中之后会永久留在群里
   * ——频道马甲尤其如此，banChatSenderChat 没有 revoke_messages。
   * 容量见 AD_DETECT_MAX_PENDING_DELETE_IDS。
   */
  pendingDeleteIds: number[];
  /**
   * 这一串已经因为待删列表撑满而丢过 id。只为让那行错误日志每个发送者最多记
   * 一次：溢出之后**每条**新消息都会再挤掉一个，逐条记就是往 logs/ 里刷屏，
   * 而运维需要知道的只是「这个人有广告删不掉了」这一件事。
   */
  pendingDeleteOverflowed?: boolean;
  /**
   * 这一串已经因为单 key 条数上限挤掉过**从没判定过**的正文。同上，只为让那行
   * 错误日志每个发送者最多记一次。丢掉的正文再也进不了分类器，这是本模块唯一
   * 一处「内容级」漏判，必须留下痕迹——否则运维只能看到判定结果偏松，查不出
   * 是模型放过了还是正文压根没送到。
   */
  uncheckedEvicted?: boolean;
  /** 下一条消息要用的序号；只增不减，上下文裁剪不回退它。 */
  nextSeq: number;
  /**
   * 已送检过的最大序号；只有序号比它大的消息才值得重新入队。
   *
   * 用序号而不是「已检条数」记账：一次判定要等一趟 provider 往返，这期间
   * 发送者可能又说了几句，已消费上下文也可能被裁掉。按数组下标记账会把裁剪
   * 腾出来的位置算成「已经检过」，让新消息永远送不出去。
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
