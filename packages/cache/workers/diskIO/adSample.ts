import type { AppendOnlyFileState } from "../../../types/diskIO/storage";

/**
 * 广告命中样本文件（packages/workers/diskIO/adSampleFile.ts）的落盘线程内存状态。
 *
 * 只有一个追加游标，没有待写缓冲：样本是纯旁路素材，写失败就丢，不进统一
 * flush、不占重试预算（理由见 adSampleFile.ts 的文件头）。
 */

/**
 * 样本文件的追加游标。null 表示还没打开过、或上一次追加失败已作废——
 * 下一次写入前会重新探测文件形态。Worker 重建后从 null 起步，重新打开即可，
 * 没有任何需要从磁盘读回内存的状态。
 */
export const adSampleFileState: { current: AppendOnlyFileState | null } = { current: null };

/**
 * 本进程是否已经清扫过 memory/ad-detected/ 里的孤儿 .tmp。
 *
 * 启动成功后的维护或第一次写入会清扫，用这面旗保证一个 isolate 只做一次
 * readdir。Worker 重建后回到 false，重新扫一次，覆盖上一个 isolate 崩溃留下的残片。
 */
export const adSampleTempsSwept: { current: boolean } = { current: false };

/**
 * 最近完成或尝试过归档保留期清扫的东京日期。只有日期严格前进时才再扫，避免
 * 每条样本触发 readdir，也避免系统时钟回拨后同一自然日重复扫描。Worker 重建后
 * 回到 null，可安全重扫一次；清扫失败也记录日期，失败本身不能拖累旁路追加。
 */
export const adSampleArchiveSweepDay: { current: string | null } = { current: null };

/** 每日归档选名的最小有界游标；完整生命周期见 adSampleArchiveCursor。 */
export interface AdSampleArchiveCursor {
  /** 当前索引所属的东京日期。 */
  readonly day: string;
  /** 按既有命名规则应当从哪个正整数候选继续碰撞检查；1 表示无序号文件。 */
  readonly nextIndex: number;
}

/**
 * 广告样本归档的下一个候选索引。
 *
 * - 填充：每日保留期目录扫描完成后，从同一份目录快照算出最小空缺；每次成功
 *   选名后前移一格。
 * - 清理/重建：Worker 重建后为 null，由首次样本触发的目录扫描重建；日期变化
 *   时用新日扫描结果整体替换。
 * - 容量：一个日期和一个安全整数，无增长。
 * - 碰撞策略：使用前仍以 existsSync 向前复核，因此外部新增归档不会被覆盖。
 */
export const adSampleArchiveCursor: {
  current: AdSampleArchiveCursor | null;
} = { current: null };
