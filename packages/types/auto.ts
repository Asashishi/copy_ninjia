import type { Message } from "@grammyjs/types";
import type { TimestampDeque } from "../libs/timestampDeque";
import type {
  AiBotInfo,
  AiDirectTriggerReason,
  AiReplyReference,
} from "./aiChat/protocol";

/** 单群随机 AI 触发概率所需的最近活跃窗口。 */
export interface AiReplyActivityEntry {
  /** 只保留足以把随机搭话概率计算到热群下限的最新消息时间戳。 */
  timestamps: TimestampDeque;
  /** 主线程内严格递增的访问序号；仅在满载插入新群时用于选择 LRU。 */
  lastAccessSequence: number;
  lastObservedAt: number;
}

/** 文本与媒体处理器共用的一次消息触发快照。 */
export interface MessageTriggerContext {
  message: Message;
  chatId: number;
  /**
   * 本条消息统一的「现在」，由 auto/message/index.ts 一次取得后传下来。
   *
   * 吃 now 的判定一律读这个字段，不得自己再调 Date.now()：同一条消息的活跃度
   * 入窗、安静期与随机冷却必须落在同一时刻，且热路径不重复读取墙钟。
   * @see ../../docs/cn/04-invariants.md
   */
  now: number;
  bot: AiBotInfo;
  isQuiet: boolean;
  aiReplyProbability: number;
  repliedTo?: Message;
  replyReference?: AiReplyReference;
  /** 当前消息本身是转发时的来源标注；非转发省略。 */
  forwardedFrom?: string;
  isMentioned: boolean;
  hasOtherMention: boolean;
  repliesToSelf: boolean;
  /**
   * 触发消息所在的论坛话题 id；General、非论坛群与讨论组评论为 undefined。
   *
   * 由 createMessageTriggerContext 一次解析后传下来，供本条消息派生的记录与触发
   * 载荷共用——话题群里不挂回复的主动发送缺了它就会掉进 General
   * （判定见 ../libs/forumTopic.ts）。
   */
  messageThreadId?: number;
  /**
   * 直接唤起的成因；随机/无触发为 undefined。
   *
   * 摊平成字符串而不是包一个 `{ reason }` 对象，理由与
   * types/aiChat/protocol.ts 里 voiceMime/voiceDurationSeconds 那段完全相同：
   * 这条上下文每条消息造一次、还要随媒体记录跨线程 clone 一次，多一层按类型
   * 才出现的嵌套对象既多一次分配，也让消费侧在「有对象」与「没对象」之间多态。
   * 字段名与 types/aiChat/replies.ts 的 directTriggerReason 保持一致。
   */
  directTriggerReason?: AiDirectTriggerReason;
}

/** 提及相关的两个触发事实，由消息实体的一次遍历得到。 */
export interface MentionFacts {
  /** 消息里 @ 到了机器人自己；只按 Telegram entity 精确识别，不做子串匹配。 */
  isMentioned: boolean;
  /**
   * 消息提及了机器人以外的用户：显式 `@username` 和 Telegram 的隐藏用户名
   * 提及 `text_mention` 都算，会阻止随机 AI 插话；同时提及机器人时仍由
   * 调用方的直接触发分支优先处理。
   */
  hasOtherMention: boolean;
}

/**
 * 随机媒体评价的掷骰结果。
 *
 * **三态而不是 `{ candidate, claimed }` 两个布尔**：`claimed` 蕴含 `candidate`，
 * 四种组合里只有三种有意义；而返回对象意味着 photo/sticker/animation/voice
 * 四条每消息路径各白付一次分配（见 AGENTS.md 的「高频路径……不得创建投影
 * 对象」）。字符串字面量是常量，比较不产生任何分配，也比位标量读得懂。
 *
 * - `none`：没掷中，这条媒体不成为评价候选。
 * - `candidate`：掷中了，但「群 × 发言人」的冷却名额没抢到。
 * - `claimed`：掷中且占到名额，解析完成后真的会评价。
 */
export type RandomMediaTrigger = "none" | "candidate" | "claimed";
