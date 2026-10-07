/** AI 群聊逐字缓存与持久化记忆 schema。 */

import type { AiSpeakerSnapshot } from "./speaker";

/**
 * 一条 Telegram 回复所指向的原消息快照。
 *
 * 可选字段一律写成 `T | undefined` 而非 `?:`，与 AiSpeakerSnapshot 相同，对象形状恒定。
 */
export interface BufferedReplyReference extends AiSpeakerSnapshot {
  messageId: number;
  /** 原消息正文；媒体消息使用可读的类型占位和 caption。 */
  text: string;
  /** 用户在 Telegram 中只选中一段原文引用时的精确片段；没有时为 undefined。 */
  quote: string | undefined;
  /** 原消息是转发时的来源标注（预格式化身份文本）；非转发为 undefined。 */
  forwardedFrom: string | undefined;
}

/**
 * 逐字缓存里的一条消息（上限 VERBATIM_CONTEXT_MAX 条）。字段顺序即构造顺序，
 * 可选字段同样是 `T | undefined`。
 */
export interface BufferedMessage extends AiSpeakerSnapshot {
  /** Telegram message_id；热区每条消息都必须可索引。 */
  messageId: number;
  text: string;
  /** 当前消息显式回复的原消息；非回复消息为 undefined。 */
  replyTo: BufferedReplyReference | undefined;
  /** 当前消息本身是转发时的来源标注（预格式化身份文本）；非转发为 undefined。 */
  forwardedFrom: string | undefined;
  /** 已格式化的配置时区的时间。 */
  at: string;
  /**
   * 机器人自发图片尚未写入画面内容时的占位状态；普通消息与已有内容的图片为 undefined。
   * 占位态的 text 只有自录记号（生图带提示词）与图注，识图完成后由
   * workers/aiChat/botImages.ts 按本字段重写 text 并清空本字段。
   */
  pendingImage: PendingBotImage | undefined;
}

/**
 * 机器人自发图片的来源，决定回填时使用的自录记号：命令与定时任务发图、
 * 生图、带参考素材的生图（见 consts/aiChat/prompts/transcript.ts 的 botImageTagTemplate）。
 */
export type BotImageOrigin = "command" | "generated" | "referenceGenerated";

/** 占位态图片回填画面内容所需的全部事实。 */
export interface PendingBotImage {
  origin: BotImageOrigin;
  /** 已清洗的图注；没有图注为空串。回填后原样接在记号之后。 */
  caption: string;
}

/** chat_states.ai_context 的版本化落盘结构。 */
export interface AiMemorySnapshot {
  version: 1;
  buffer: BufferedMessage[];
  summaries: string[];
  pendingSummary: string | null;
  savedAt: number;
}

/**
 * 某群 AI 上下文此刻的占用量：滑动热记忆条数与冷记忆摘要轮数。
 *
 * 权威值在 AI Worker 的滚动记忆容器里（见 cache/workers/aiChat/memory.ts 的
 * chatBuffers 与 chatSummaries），随记忆快照上报和 hydrate 完成过线到主线程只读
 * 镜像（见 cache/main/aiChat.ts 的 aiMemoryUsages），供 `/bot_status` 展示。
 *
 * 两个计数都不含 pendingSummaries。
 */
export interface AiMemoryUsage {
  /** 滚动缓存中的逐字消息条数，上限 VERBATIM_CONTEXT_MAX。 */
  readonly bufferedCount: number;
  /** 已晋升的冷记忆摘要轮数，上限 MAX_SUMMARY_ROUNDS。 */
  readonly summaryCount: number;
}
