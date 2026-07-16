import type { AiMemorySnapshot, DayFileState, LuckDayCache, LuckPendingEntry, StickerCatalogSnapshot } from "../types";

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

// ---- 贴纸目录 ----

/** 各白名单贴纸包最新的目录快照（覆盖式 upsert），键为 pack short name。 */
export const stickerCatalogCache: Map<string, StickerCatalogSnapshot> = new Map();
/** 自上次落盘后有更新、待写入磁盘的贴纸包。与 dirtyChats 共用同一条定时
 *  落盘窗口（见 workers/diskIOWorker.ts 的 scheduleSnapshotFlush）。 */
export const dirtyStickerPacks: Set<string> = new Set();

// ---- 每日运势 ----

/** 当日已知的运势结果：day + entries（key -> LuckDrawRecord）。含义是"今天
 *  见过的全部 key 及其最新值"，不区分是刚从磁盘恢复的、还是本次运行期间
 *  新确认落盘的——唯一用途是去重（luckDraw 消息到达时判断 key+值是否与
 *  已知记录完全一致，见 workers/diskIO/luckFiles.ts 的 handleLuckDrawMessage）
 *  和启动时的 LoadedReply，不是落盘时的数据源（落盘只追加
 *  luckPendingAppends 里还没写出去的那一小撮，见 workers/diskIO/
 *  snapshotFiles.ts 的 appendLuckEntries）。跨天时整体丢弃重建（旧 day
 *  已是昨日黄花），见 handleLuckDrawMessage。 */
export const luckWorkerCache: { current: LuckDayCache | null } = { current: null };

/** 尚未追加进磁盘文件的运势新条目：已经过 luckWorkerCache 去重，只有真正
 *  的新 key 才会进来。flush 时把它们追加进当天文件末尾（按位置追加，见
 *  appendOnlyDayFile.ts）后清空；是否为空直接充当"运势有没有 dirty"的
 *  判断，不再需要单独的布尔标记。 */
export const luckPendingAppends: LuckPendingEntry[] = [];

/** 当前追加目标运势文件的状态，重启即清空（下次写入时重新探测/打开对应
 *  日期的文件）；机制与 loggerFileState 相同，见 appendOnlyDayFile.ts。 */
export const luckFileState: { current: DayFileState | null } = { current: null };

/** 运势追加缓冲的定时落盘句柄，见 workers/diskIO/luckFiles.ts 的
 *  scheduleLuckFlush——独立于下面 AI 记忆的 snapshotFlushState，条数/时间
 *  阈值也不一样（见 consts/diskIO.ts 的 FLUSH_MAX_ENTRIES/FLUSH_INTERVAL_MS），
 *  两条互不影响。 */
export const luckFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

// ---- AI 记忆的定时落盘 ----

/** AI 记忆快照的定时落盘句柄，见 workers/diskIOWorker.ts 的 scheduleSnapshotFlush。 */
export const snapshotFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
