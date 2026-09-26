import type { TtsDailyUsage } from "../../../types/aiChat/voiceMessage";

/** owner: workers/aiChat。语音合成每日计数（packages/aiChat/ai/ttsUsage.ts）的权威值。 */

/**
 * 当前计数窗口；null 表示从没发起过合成请求。
 *
 * 填充：init 之后主线程投递的 hydrateTtsUsage 写入 memory/global/state.json 的 `ttsUsage` 恢复出的
 * 值，Worker 崩溃重建时主线程改为重放它持有的最新 ttsUsage 回执。每次登记整体替换成
 * 新对象，并以 ttsUsage 事件交给主线程落盘。清理：过期窗口不主动清除，下一次登记时
 * 换成以本次请求为起点的新窗口。容量恒为一个对象。
 */
export const ttsDailyUsage: { current: TtsDailyUsage | null } = { current: null };
