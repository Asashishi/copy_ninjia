/** 日志门面（src/logger.ts）的内存状态。 */

/**
 * flushLogs 的回执路由：flushId → resolve。只在主线程（拥有落盘 Worker 的
 * 那一侧）被使用；Worker 线程里的 logger 走转发模式，没有本地落盘 buffer。
 */
export const pendingFlushes: Map<number, () => void> = new Map();
