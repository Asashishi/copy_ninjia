/** owner：Disk I/O Worker（packages/workers/diskIOWorker.ts）。 */

/**
 * 当前是否正处在主线程恢复缓冲的重放区间内。
 *
 * 由主线程 activateDiskIOWorker 在重放前后各发一条 `recoveryReplay` 标记开合
 * （见 types/diskIO.ts 的 RecoveryReplayRequest）。填充时机 = 收到 active:true；
 * 清理时机 = 收到 active:false，或本 Worker 因崩溃被替换——新 Worker 从 false
 * 起步，而新一轮重放必然重新发一次 active:true，不需要跨实例沿用。
 *
 * fail-safe 方向是 false：漏收开标记会按在线消息处理；错误地留成 true 则会把
 * 普通在线写失败升级成整进程停机。因此只有显式 active:false 与新实例初值负责
 * 清零，不设超时自动复位。
 */
export const diskIOReplayWindow: { current: boolean } = { current: false };

/** 仅供单测在用例之间重置窗口状态，避免一个用例遗留的 true 影响下一个。 */
export function resetDiskIOReplayWindow(): void {
  diskIOReplayWindow.current = false;
}
