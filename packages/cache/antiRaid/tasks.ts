/** Anti-Raid Worker 异步副作用排空（packages/workers/antiRaid/taskTracker.ts）的内存状态。 */

/**
 * 已启动且尚未结算的网络副作用。任务完成时由 tracker 删除；Worker stop 时
 * 整体清空，重建后由主线程持久化镜像重新投递必要任务。
 */
export const antiRaidInFlightTasks: Set<Promise<unknown>> = new Set();

/**
 * tracker 生命周期代际。Worker stop 时递增，使旧 Promise 的迟到 finally
 * 不能清理下一次 start 已建立的新任务状态。
 */
export const antiRaidTaskTrackerGeneration: { current: number } = { current: 0 };
