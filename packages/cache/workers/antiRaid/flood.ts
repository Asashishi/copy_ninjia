/** Owner：AntiRaid Worker；主线程只能通过 floodCandidate 消息间接写入。 */

import type {
  FloodWindowCacheState,
  FloodWindowEntry,
} from "../../../types/antiRaid/internal";

/**
 * 按 chatId → userId 两层数值索引记的一分钟发言窗口，纯内存、不落盘。
 *
 * 由主线程投来的 `floodCandidate` 逐条填充；条目自身组成无分配的双向 LRU，条目
 * 数由 FLOOD_WINDOW_MAX_MEMBERS 兜住（见 consts/antiRaid/flood.ts）。单条队列长度天然
 * 被阈值封顶（命中即清空），因此整表占用是「条目数 × 阈值」这个常数上界。
 * 空闲满一个窗口的条目由 Worker 的统一 sweep 节拍删除（sweepFloodWindows），
 * 避免空闲群在容量未满时长期占用名额。
 *
 * 停管、`/init disable` 与群 teardown（deactivateChat）清掉该群的全部条目；
 * Worker 崩溃重建或进程重启后整表为空、从零重新计数，也无需恢复——Telegram
 * 侧的禁言由 `until_date` 自行到期，不依赖本进程活着。
 */
export const floodWindowsByChat: Map<number, Map<number, FloodWindowEntry>> = new Map();

/**
 * 分层索引的全局条目数及 LRU 两端。
 *
 * 每次候选消息原地刷新，淘汰、TTL sweep、停管和 reset 同步摘链；Worker 崩溃或
 * 进程重启后由模块初始化为空。entryCount 恒不超过 FLOOD_WINDOW_MAX_MEMBERS，
 * newest/oldest 只指向仍在 floodWindowsByChat 中的条目。
 */
export const floodWindowCacheStateHolder: { current: FloodWindowCacheState } = {
  current: { entryCount: 0, newest: null, oldest: null },
};
