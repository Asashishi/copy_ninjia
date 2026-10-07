/**
 * Worker 崩溃自愈的节流参数，供 infra/supervisedWorker.ts（AI 与 Anti-Raid 业务 Worker 经
 * aiChat/workerBridge.ts、antiRaid/workerBridge/controller.ts 接入）与 Disk I/O Worker 重建
 * （infra/diskIO/recovery.ts、cache/main/diskIO.ts）共用（见 libs/restartThrottle.ts）：
 * 窗口内重启次数用尽即放弃自愈；窗口外的崩溃不占名额，照常重启。此常量为窗口内允许的重启次数。
 */
export const WORKER_MAX_RESTARTS: number = 5;
/** Worker 重启计数采用的滑动窗口时长。 */
export const WORKER_RESTART_WINDOW_MS: number = 60_000;
