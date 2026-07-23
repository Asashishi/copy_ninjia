import type { CopyMode } from "../types/chatState";

/** 消息自动流水线（src/auto）的调参常量。 */

/**
 * 同一群里同一用户两次随机 AI 触发之间的最短间隔，只限制随机插话和媒体
 * 评价。回复/@ 机器人等直接交互由 Worker 的并发闸与有界队列承接，不允许
 * 在主线程静默丢弃。
 */
export const USER_REPLY_TRIGGER_COOLDOWN_MS: number = 15_000;

/** 没有复读对象时，随机复读一条新消息的概率。 */
export const RANDOM_ECHO_PROBABILITY: number = 1 / 100;

/** 随机复读时的模式池：undefined 表示原样复读，其余对应各 /*_copy 的文本变换。 */
export const RANDOM_ECHO_MODES: (CopyMode | undefined)[] = [undefined, "reverse", "nya", "ja"];

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
