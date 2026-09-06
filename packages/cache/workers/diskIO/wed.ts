/** Owner: Disk I/O Worker。/wed 全量替换的待写快照。 */

/**
 * 主线程批量投递时接管最终数组，写成功即释放；每群一份，容量受主线程群数和成员数上限约束。
 * 仅用于持久化防丢失；权威集合在主线程，Worker 重建后由主线程全量重放。
 * 缺失条目表示没有待写快照，不表示沿用旧值；进程重启由文件恢复成员。
 * 跨线程持久化与停机约束见 docs/cn/04-invariants.md。
 */
export const pendingWedMembers: Map<number, readonly number[]> = new Map();

/** 与待写快照同步登记；统一 dirty flush 成功清理，失败保留，Worker 重建由主线程重放。容量为群数上限。 */
export const dirtyWedChats: Set<number> = new Set();

/** 写失败时建立唯一重试 timer；成功或启动接管时清理，Worker 重建重新调度。 */
export const wedFileFlushTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };

/** 启动接管或测试隔离时清除旧代待写状态。 */
export function resetWedFileWrites(): void {
  if (wedFileFlushTimer.current !== null) clearTimeout(wedFileFlushTimer.current);
  wedFileFlushTimer.current = null;
  pendingWedMembers.clear();
  dirtyWedChats.clear();
}
