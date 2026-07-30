import type { FloodWindowEntry } from "../../../types/antiRaid/internal";

/** 刷屏禁言（packages/workers/antiRaid/floodControl.ts）的 Worker 侧内存状态。 */

/**
 * 按「chatId:userId」记的一分钟发言窗口，纯内存、不落盘。
 *
 * 由主线程投来的 `floodCandidate` 逐条填充；Map 顺序同时是 LRU 顺序，条目数由
 * FLOOD_WINDOW_MAX_MEMBERS 兜住（见 consts/antiRaid/flood.ts）。单条队列长度天然
 * 被阈值封顶（命中即清空），因此整表占用是「条目数 × 阈值」这个常数上界。
 * 空闲满一个窗口的条目由 Worker 的统一 sweep 节拍删除（sweepFloodWindows）——
 * 仅靠 LRU 的话，一个曾经热闹过的群会一直占着名额把真正活跃的群挤出去。
 *
 * 停管、`/init disable` 与群 teardown（deactivateChat）清掉该群的全部条目；
 * Worker 崩溃重建或进程重启后整表为空、从零重新计数，也无需恢复——Telegram
 * 侧的禁言由 `until_date` 自行到期，不依赖本进程活着。
 */
export const floodWindowsByMember: Map<string, FloodWindowEntry> = new Map();
