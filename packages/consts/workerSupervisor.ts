/**
 * Worker 崩溃自愈的节流参数，供 infra/supervisedWorker.ts（AI 与 Anti-Raid 业务 Worker 经
 * aiChat/workerBridge.ts、antiRaid/workerBridge/controller.ts 接入）与 Disk I/O Worker 重建
 * （infra/diskIO/recovery.ts、cache/main/diskIO.ts）共用（见 libs/restartThrottle.ts）：短时间内反复崩溃（多半是代码本身
 * 有 bug，重启也没用）就放弃自愈；崩溃很稀疏（相隔够久）则不受影响，
 * 每次都正常重启。
 */
export const WORKER_MAX_RESTARTS: number = 5;
/** Worker 重启计数采用的滑动窗口时长。 */
export const WORKER_RESTART_WINDOW_MS: number = 60_000;
