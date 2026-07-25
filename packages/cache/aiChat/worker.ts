/**
 * AI Worker 的统一维护 interval。Worker 启动时填充，协作式停止时清除；
 * 崩溃时随 isolate 销毁，新 Worker 从空 holder 重建，容量固定为一个 timer。
 */
export const aiChatMaintenanceTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
