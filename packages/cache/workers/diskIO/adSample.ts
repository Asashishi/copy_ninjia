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
 * 这个领域按设计没有启动恢复钩子（进程从不读样本文件），清扫只能挂在第一次写入
 * 前，用这面旗保证一个 isolate 只做一次 readdir。Worker 重建后回到 false，重新
 * 扫一次，正好覆盖上一个 isolate 崩溃留下的残片。
 */
export const adSampleTempsSwept: { current: boolean } = { current: false };

/**
 * 最近完成或尝试过归档保留期清扫的东京日期。只有日期严格前进时才再扫，避免
 * 每条样本触发 readdir，也避免系统时钟回拨后同一自然日重复扫描。Worker 重建后
 * 回到 null，可安全重扫一次；清扫失败也记录日期，失败本身不能拖累旁路追加。
 */
export const adSampleArchiveSweepDay: { current: string | null } = { current: null };
