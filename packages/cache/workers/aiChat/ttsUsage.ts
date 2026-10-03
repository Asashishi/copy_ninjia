/** owner: workers/aiChat。语音合成每日计数（packages/aiChat/ai/ttsUsage.ts）的权威值。 */

import type { TtsDailyUsage } from "../../../types/aiChat/voiceMessage";

/**
 * AI 与预留额度的共同窗口及各自计数；null 表示从没发起过合成请求。
 *
 * 填充：init 之后主线程投递的 hydrateTtsUsage 写入 memory/global/state.json 的 `ttsUsage` 恢复出的
 * 值，Worker 崩溃重建时主线程改为重放它持有的最新 ttsUsage 回执。每次登记整体替换成
 * 新对象，并以 ttsUsage 事件交给主线程落盘。清理：过期窗口不主动清除，下一次登记时
 * 两项一起重置，并换成以本次请求为起点的新窗口。容量恒为一个对象。
 */
export const ttsDailyUsage: { current: TtsDailyUsage | null } = { current: null };

/**
 * AI 语音工具已准入、TTS 调用还没结束的 `ai` 口径预留数（见 aiChat/ai/ttsUsage.ts 的
 * reserveAiTtsUsage）。它计入模型可见余量与准入判定，不进 agentCount、不落盘。
 *
 * 填充：send_voice 准入通过时加一。清理：同一次 TTS 调用结束时减一——成功时同时登记
 * agentCount，失败、取消或意外异常时只释放（settleAiTtsReservation）。
 * Worker 崩溃重建：新 isolate 从 0 起步，旧 isolate 里在途的合成随之终止，不需要重放。
 * 容量：不超过同时在途的 send_voice 合成数（每轮回复至多 MAX_VOICES_PER_REPLY 条）。
 */
export const pendingAiTtsReservations: { current: number } = { current: 0 };
