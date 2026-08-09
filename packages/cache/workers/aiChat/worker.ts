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
