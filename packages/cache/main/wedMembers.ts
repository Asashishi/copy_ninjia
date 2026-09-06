/** Owner: 主线程。/wed 已发言成员集合与合并落盘窗口。 */
import type { WedMemberState } from "../../types/wed";

/**
 * init 从 DiskIO 严格校验的快照恢复；实际个人发言新增，退群移除。
 * 每群最多 WED_MEMBER_LIMIT 个 number，群数受 STATE_MANAGED_CHAT_LIMIT 限制；满额拒绝新增。
 * 群交互 teardown 保留成员，进程初始化清空后从文件恢复。
 * 本表是权威 owner；DiskIO 崩溃后由主线程全量重放，缺失条目表示没有候选。
 * 仅批量窗口关闭时投递最终数组，普通发言不创建快照或跨线程同步。
 * 跨线程持久化与停机约束见 docs/cn/04-invariants.md。
 */
export const wedMemberStates: Map<number, WedMemberState> = new Map();

/** 首次变更创建 timer，累计阈值提前调度；发送或初始化清理，失败保留 dirty 并定时重试。容量为一个 timer 和两个标量。 */
export const wedMemberFlushState: {
  timer: ReturnType<typeof setTimeout> | null;
  changes: number;
  immediate: boolean;
} = { timer: null, changes: 0, immediate: false };

/** init 或测试隔离时清除整份 owner；Worker 重建不得调用。 */
export function resetWedMemberStates(): void {
  if (wedMemberFlushState.timer !== null) clearTimeout(wedMemberFlushState.timer);
  wedMemberFlushState.timer = null;
  wedMemberFlushState.changes = 0;
  wedMemberFlushState.immediate = false;
  wedMemberStates.clear();
}
