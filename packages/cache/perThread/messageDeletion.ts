import type { PendingMessageDeletion } from "../../types/telegram";

/**
 * Telegram 延迟删除的 per-thread 状态。主线程和各 Worker 各持一份，不能跨线程
 * 共享 Api 句柄；主线程实例由应用生命周期排空，Worker 实例随各自生命周期处理。
 */

/**
 * 尚未到期的删除任务。发送成功后登记，到期或停机提前兑现时删除；容量等于一个
 * 延迟窗口内成功发出的临时消息数，timer 全部 unref，线程重建后清空。
 */
export const pendingMessageDeletions: Set<PendingMessageDeletion> = new Set();

/**
 * 已开始 Telegram 删除、尚未结算的任务。任务 settle 后立即删除；用于停机排空
 * 等待已经发出的请求，容量不超过同时兑现的 pending 数，线程重建后清空。
 */
export const inFlightMessageDeletions: Set<Promise<void>> = new Set();
