/**
 * Anti-Raid Worker 唯一的缓存清扫 interval。启动时填充，协作式停止时
 * 清除；Worker 崩溃后随 isolate 销毁，新实例重新创建，容量固定为一个 timer。
 */
export const antiRaidCacheSweepTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
