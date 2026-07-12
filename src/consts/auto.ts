import type { CopyMode } from "../types";

/** 消息自动流水线（src/auto）的调参常量。 */

/** 同一群里同一用户两次被 AI 随机回复之间的最短间隔。 */
export const USER_RANDOM_REPLY_COOLDOWN_MS: number = 90_000;

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
