import type { MentionFacts } from "../types/auto";
import type { CopyMode } from "../types/chatState";

/** 消息自动流水线（packages/auto）的调参常量。 */

/**
 * 同一群里同一用户两次随机 AI 触发之间的最短间隔，只限制随机插话和媒体
 * 评价。回复/@ 机器人等直接交互由 Worker 的并发闸与有界队列承接，不允许
 * 在主线程静默丢弃。
 */
export const USER_REPLY_TRIGGER_COOLDOWN_MS: number = 15_000;

/**
 * 主线程随机回复个人冷却表的硬顶。达到上限且没有过期条目可清时，宁可
 * 放弃新的随机回复，也不淘汰仍生效的冷却、让高基数流量绕过限频。
 */
export const USER_REPLY_TRIGGER_CACHE_MAX: number = 5_000;

/** 没有复读对象时，随机复读一条新消息的概率。 */
export const RANDOM_ECHO_PROBABILITY: number = 1 / 100;

/** 随机复读时的模式池：undefined 表示原样复读，其余对应各 /*_copy 的文本变换。 */
export const RANDOM_ECHO_MODES: readonly (CopyMode | undefined)[] = [undefined, "reverse", "nya"];

/**
 * 「说到洗澡就回看看」的触发词：洗澡 / 泡澡（中间可插最多 4 个白名单里的
 * 助词/修饰字，白名单挡「洗刷刷澡堂子见」这类字面撞上的误伤）以及冲凉
 * （繁体沖涼，中间可插「个/個/了」等）。
 */
export const BATH_TRIGGER_PATTERN: RegExp = /[洗泡][个個了完一热熱水冷好]{0,4}澡|[冲沖][个個了完一]{0,2}[凉涼]/;

/** 「说到洗澡就回看看」只对短消息生效（字符数 ≤ 此值），避免长文里偶然带出也被打扰。 */
export const BATH_TRIGGER_MAX_MESSAGE_LENGTH: number = 15;

/** 「说到洗澡就回看看」的固定回复文本：发送与自录进 AI 对话缓存共用同一个常量，避免两处字面量各改各的漂移。 */
export const BATH_TRIGGER_REPLY_TEXT: string = "看看";

/** resolveSpeaker 解析发言人身份时的兜底展示名：频道马甲缺 title、以及既非频道也非真实用户（理论不可达的防御分支）时使用。 */
export const FALLBACK_CHANNEL_NAME: string = "某频道";
/** 无法解析到用户或频道身份时使用的最终兜底展示名。 */
export const FALLBACK_SPEAKER_NAME: string = "某杂鱼";

/**
 * 消息没有 entity 表时的提及事实（auto/message/facts.ts 的 resolveMentionFacts）：
 * 两项都为 false。全局共享一份，调用方只读字段，不得修改。
 */
export const NO_MENTION_FACTS: Readonly<MentionFacts> = { isMentioned: false, hasOtherMention: false };

/**
 * 非文本消息的类型标签（所属模块：auto/message）。回复引用在原消息已滑出 AI 缓存时
 * 用它兜底（facts.ts），媒体解析不出素材时也用它作纯文本上下文（animation.ts）；
 * 带 caption 时由 libs/text.ts 的 composeMediaText 以空格接上。
 */
export const PHOTO_PLACEHOLDER: string = "[图片]";
/** GIF 的类型标签；用法同 PHOTO_PLACEHOLDER。 */
export const ANIMATION_PLACEHOLDER: string = "[GIF]";
/** 视频的类型标签；用法同 PHOTO_PLACEHOLDER。 */
export const VIDEO_PLACEHOLDER: string = "[视频]";
/** 圆形视频消息的类型标签；不带 caption。 */
export const VIDEO_NOTE_PLACEHOLDER: string = "[视频消息]";
/** 语音的类型标签；用法同 PHOTO_PLACEHOLDER。 */
export const VOICE_PLACEHOLDER: string = "[语音]";
/** 音频文件的类型标签；用法同 PHOTO_PLACEHOLDER。 */
export const AUDIO_PLACEHOLDER: string = "[音频]";
/** 位置的类型标签；不带 caption。 */
export const LOCATION_PLACEHOLDER: string = "[位置]";
/** 以上类型都不匹配时的兜底标签。 */
export const NON_TEXT_PLACEHOLDER: string = "[非文本消息]";

/** 贴纸的类型标签；有 emoji 时写成 `[贴纸：😺]`，否则为 `[贴纸]`。所属模块：auto/message/facts.ts。 */
export function stickerPlaceholder(emoji: string | undefined): string {
  return emoji ? `[贴纸：${emoji}]` : "[贴纸]";
}

/** 文件的类型标签；有文件名时写成 `[文件：a.pdf]`，否则为 `[文件]`。所属模块：auto/message/facts.ts。 */
export function documentPlaceholder(fileName: string | undefined): string {
  return fileName ? `[文件：${fileName}]` : "[文件]";
}

/** 投票的类型标签，带题目。所属模块：auto/message/facts.ts。 */
export function pollPlaceholder(question: string): string {
  return `[投票：${question}]`;
}

/** 骰子的类型标签，带表情与点数。所属模块：auto/message/facts.ts。 */
export function dicePlaceholder(emoji: string, value: number): string {
  return `[骰子：${emoji} ${value}]`;
}

/** 联系人的类型标签；姓氏存在时以空格接在名字后。所属模块：auto/message/facts.ts。 */
export function contactPlaceholder(firstName: string, lastName: string | undefined): string {
  return lastName ? `[联系人：${firstName} ${lastName}]` : `[联系人：${firstName}]`;
}

/** 地点的类型标签，带地点名。所属模块：auto/message/facts.ts。 */
export function venuePlaceholder(title: string): string {
  return `[地点：${title}]`;
}

/** 无法转写的语音在上下文里的标签，带时长秒数。所属模块：auto/message/voice.ts。 */
export function voiceDurationPlaceholder(durationSeconds: number): string {
  return `[语音 ${durationSeconds} 秒]`;
}
