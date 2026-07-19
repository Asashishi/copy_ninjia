/** 心情的随机寿命区间：抽到后过这么久自然到期重抽，与群是否活跃无关；
 *  心情与到期时刻均不落盘。 */
export const MOOD_REROLL_MIN_MS: number = 2 * 60 * 60_000;
export const MOOD_REROLL_MAX_MS: number = 4 * 60 * 60_000;
