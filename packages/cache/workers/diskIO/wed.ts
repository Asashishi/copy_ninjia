/** Owner: Disk I/O Worker。/wed 全量替换的待写快照。 */
import type { WedMembersDeletedPersistedReply } from "../../../types/diskIO/replies";

/**
 * 主线程批量投递时接管最终数组，写成功即释放；每群一份，容量受主线程群数和成员数上限约束。
 * 仅用于持久化防丢失；权威集合在主线程，Worker 重建后由主线程全量重放。
 * 缺失条目表示没有待写快照，不表示沿用旧值；进程重启由文件恢复成员。
 * 跨线程持久化与停机约束见 docs/cn/04-invariants.md。
 */
export const pendingWedMembers: Map<number, readonly number[]> = new Map();

/** 与待写快照同步登记；统一 dirty flush 成功清理，失败保留，Worker 重建由主线程重放。容量为群数上限。 */
export const dirtyWedChats: Set<number> = new Set();

/**
 * 已收到整群删除、但文件还没删掉的群。
 *
 * 主线程在群 teardown 时投递一次 `deleteWedMembers` 即登记；unlink 成功即摘除，
 * 失败保留并由统一 dirty flush 的重试 timer 继续尝试，期间 wedMembers 领域
 * flush 一律回报失败，teardown 因此不会把「文件还在」报成删干净了。容量与群数
 * 上限同阶；新快照取消旧删除；Worker 重建后为空，未确认删除由主线程全量重投。
 */
export const deletedWedChats: Map<number, number> = new Map();

/** Worker 启动安装回执出口，durable unlink 后调用；实例销毁释放，测试缺省不发送，容量一项。 */
export const wedMemberDeletePersistedNotifier: { current: (reply: WedMembersDeletedPersistedReply) => void } = {
  current: (): void => { /* 独立 owner 测试未安装 Worker 回执出口。 */ },
};

/** 写失败时建立唯一重试 timer；成功或启动接管时清理，Worker 重建重新调度。 */
export const wedFileFlushTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };

/** 启动接管或测试隔离时清除旧代待写状态。 */
export function resetWedFileWrites(): void {
  if (wedFileFlushTimer.current !== null) clearTimeout(wedFileFlushTimer.current);
  wedFileFlushTimer.current = null;
  pendingWedMembers.clear();
  dirtyWedChats.clear();
  deletedWedChats.clear();
}
