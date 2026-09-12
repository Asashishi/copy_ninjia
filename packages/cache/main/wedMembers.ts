/** Owner: 主线程。/wed 已发言成员集合与合并落盘窗口。 */
import type { WedMemberState } from "../../types/wed";
import type { WedMembersDeleteDiskMessage } from "../../types/diskIO/messages";

/**
 * init 从 DiskIO 严格校验的快照恢复；实际个人发言新增，退群或每日复核确认离群时移除。
 * 每群最多 WED_MEMBER_LIMIT 个 number，群数受 STATE_MANAGED_CHAT_LIMIT 限制；满额拒绝新增。
 * 进程初始化清空后从文件恢复。
 *
 * 整群条目只在 `/init disable` 与机器人离群时由 commands/wed/persistence.ts 的
 * purgeWedMembers 删除，并连带删掉 `memory/wed/<chatId>.json`；被撤管理员与 LRU
 * 淘汰交互缓存都只收掉交互，成员集合原样保留（见 libs/chatTeardown.ts 的
 * purgesChatData）。待确认删除由 pendingWedMemberDeletes 持有，不再作为候选。
 *
 * 本表是权威 owner；DiskIO 崩溃后由主线程全量重放，缺失条目表示没有候选。
 * 仅批量窗口关闭时投递最终数组，普通发言不创建快照或跨线程同步。
 * 跨线程持久化与停机约束见 docs/cn/04-invariants.md。
 */
export const wedMemberStates: Map<number, WedMemberState> = new Map();

/**
 * teardown 摘除奖池时登记，durable 删除回执或新奖池接管后清理；投递失败按原 timer 重试。
 * 与现存奖池合计最多 STATE_MANAGED_CHAT_LIMIT 群，满额拒绝新群；同群重开不增加占额。
 * 权威 owner 为主线程，DiskIO 重建时全量重放；无条目表示没有仍需确认的删除。
 */
export const pendingWedMemberDeletes: Map<number, WedMembersDeleteDiskMessage> = new Map();
/** 删除回执的进程内唯一编号；teardown 分配，进程重启从零开始，Worker 重建不归零，容量一个标量。 */
export const wedMemberDeleteCounter: { current: number } = { current: 0 };

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
  pendingWedMemberDeletes.clear();
}
