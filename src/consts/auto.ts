import type { CopyMode } from "../types";

/** 消息自动流水线（src/auto）的调参常量。 */

/**
 * 同一群里同一用户两次触发 AI 自动回复之间的最短间隔，覆盖全部触发路径
 * （回复机器人/@机器人/拿媒体叫机器人的必回路径，以及随机插话/媒体评价——
 * 两类原本各自独立计冷却，后来发现同一个人身上仍可能因为两条路径各占各
 * 的名额而叠出并发轮，遂合并成一道统一的闸）。
 *
 * 必回路径原本完全不设冷却：同一个人短时间内连续回复/@ 机器人，每条都会
 * 独立开一轮回复（同群并发上限见 REPLY_ROUND_MAX_CONCURRENT），多轮并发
 * 针对同一个人时，各自的聊天状态心跳挡位、发贴纸互斥锁、尤其是错字模拟的
 * 撤回重发序列（见 consts/aiChat.ts 的 TYPO_RECALL_DELETE_MIN_MS/MAX_MS，
 * 一条消息发出后有 10~15 秒会被撤回重发）会互相穿插，表现为「消息发出去
 * 又消失、后续没有下文」——像是被吞掉了。这个冷却按「群 × 用户」占用一个
 * 名额，同一个人在名额期内的后续触发一律不再开新轮，从根上避免针对同一个
 * 人出现多轮并发。
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
export const FALLBACK_SPEAKER_NAME: string = "某杂鱼";
