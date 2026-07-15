import type { AiMemorySnapshot, DayFileState } from "../types";

/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）的内存状态：日志、AI 记忆
 * 两类缓存 + dirty 标记 + 定时器句柄。原则：磁盘只在启动恢复时被读一次；
 * 此后缓存是唯一事实源——读只读缓存，写是「缓存 -> 磁盘」的单向定时同步。
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

// ---- AI 记忆的定时落盘 ----

/** AI 记忆快照的定时落盘句柄，见 workers/diskIOWorker.ts 的 scheduleSnapshotFlush。 */
export const snapshotFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
