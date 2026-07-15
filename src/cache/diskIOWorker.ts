import type { AiMemorySnapshot, DayFileState, LuckDayCache } from "../types";

/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）的内存状态：日志、AI 记忆、
 * 每日运势三类缓存 + dirty 标记 + 定时器句柄。原则：磁盘只在启动恢复时被
 * 读一次；此后缓存是唯一事实源——读只读缓存，写是「缓存 -> 磁盘」的单向
 * 定时同步。
 */

// ---- 日志（原 cache/loggerWorker.ts，原样保留，行为零变化） ----

/** 当前追加目标文件的状态，重启即清空（下次写入时重新探测/打开对应日期的文件）。 */
export const loggerFileState: { current: DayFileState | null } = { current: null };

/** 内存 buffer，flush 阈值见 consts/diskIO.ts。 */
export const flushBuffer: { entries: { day: string; text: string }[]; timer: ReturnType<typeof setTimeout> | null } = {
  entries: [],
  timer: null,
};

// ---- AI 记忆 ----

/** 各群最新的 AI 记忆快照（覆盖式 upsert）。 */
export const aiMemoryCache: Map<number, AiMemorySnapshot> = new Map();
/** 自上次落盘后有更新、待写入磁盘的群。 */
export const dirtyChats: Set<number> = new Set();

// ---- 每日运势 ----

/** 当日运势缓存：day 与 entries（key -> LuckTier.label）。跨天时整体丢弃重建
 *  （旧 day 已是昨日黄花，无需落盘），见 workers/diskIOWorker.ts 处理 luckDraw 消息。 */
export const luckWorkerCache: { current: LuckDayCache | null; dirty: boolean } = {
  current: null,
  dirty: false,
};

// ---- AI 记忆 / 运势共用的定时落盘 ----

/** 快照（AI 记忆 + 运势）的定时落盘句柄，见 workers/diskIOWorker.ts 的 scheduleSnapshotFlush。 */
export const snapshotFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
