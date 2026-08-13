/**
 * AI Worker 的统一维护 interval。Worker 启动时填充，协作式停止时清除；
 * 崩溃时随 isolate 销毁，新 Worker 从空 holder 重建，容量固定为一个 timer。
 */
export const aiChatMaintenanceTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/**
 * Worker 是否已进入只排空、不再接纳新回复工作的阶段。收到首条 flushMemory 时
 * 同步置真，避免在途轮次的 finally 或迟到 mailbox 消息派生新任务；新 Worker
 * 启动时重置。容量固定为一个布尔 holder。
 */
export const aiChatWorkerQuiescing: { current: boolean } = { current: false };

/**
 * 本 Worker 唯一的排空 Promise。首条 flushMemory 填充，后续 flush 复用同一
 * 结算边界；任务完成前不清空，防止第二条 flush 越过仍在途的旧任务。Worker
 * 重建或显式重新启动时重置，容量固定为一个 Promise holder。
 */
export const aiChatWorkerDrain: { current: Promise<void> | null } = { current: null };

/**
 * AI Worker 后台任务的统一生命周期信号。Worker 启动时替换为新 controller，进入
 * quiesce 或显式停止时 abort；崩溃后随 isolate 销毁并由新 Worker 重建。容量固定
 * 为一个 controller。无独立任务条目时仍保留当前信号；aborted 表示本 Worker 不得
 * 再派生贴纸目录等后台工作，而不是沿用上一轮 controller。
 */
export const aiChatWorkerAbortController: { current: AbortController } = {
  current: new AbortController(),
};
