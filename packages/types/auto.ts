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
   * 吃 now 的判定一律读这个字段，不得自己再调 Date.now()：语义上同一条消息的
   * 活跃度入窗、安静期与随机冷却必须落在同一时刻；性能上这台部署机的
   * clocksource 是 kvm-clock，实测在带真实工作集的函数里多读一次墙钟约 3 µs。
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
   * 直接唤起的成因；随机/无触发为 undefined。
   *
   * 摊平成字符串而不是包一个 `{ reason }` 对象，理由与
   * types/aiChat/protocol.ts 里 voiceMime/voiceDurationSeconds 那段完全相同：
   * 这条上下文每条消息造一次、还要随媒体记录跨线程 clone 一次，多一层按类型
   * 才出现的嵌套对象既多一次分配，也让消费侧在「有对象」与「没对象」之间多态。
   * 实测跨线程 clone 9.05 → 4.16 µs、上下文构造 18.2 → 12.5 ns/op。
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
