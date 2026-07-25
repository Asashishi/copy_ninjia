import { TYPING_DELAY_BASE_MS, TYPING_DELAY_JITTER_MS, TYPING_DELAY_MAX_MS, TYPING_DELAY_PER_CHAR_MS } from "../../consts/aiChat/tools";

/** 每条消息临发前「正在输入…」窗口的时长（1~7.5 秒）：按本条消息的长度
 *  估一个停顿加随机抖动，再统一封顶，见 consts/aiChat.ts 的 TYPING_DELAY_*。 */
export function typingDelayMs(nextPart: string): number {
  const base: number = TYPING_DELAY_BASE_MS + nextPart.length * TYPING_DELAY_PER_CHAR_MS;
  const jitter: number = Math.random() * TYPING_DELAY_JITTER_MS;
  return Math.min(base + jitter, TYPING_DELAY_MAX_MS);
}

/** [min, max) 区间内的随机延迟（毫秒）。 */
export function randomDelayMs(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
