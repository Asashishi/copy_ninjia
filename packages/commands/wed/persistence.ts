import { wedMemberFlushState, wedMemberStates, resetWedMemberStates } from "../../cache/main/wedMembers";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { onDiskIORespawn, postDiskIO } from "../../infra/diskIO";
import type { DiskIORecoveryTransport, WedMembersDiskMessage } from "../../types/diskIO/messages";
import type { WedMemberState } from "../../types/wed";

/** 初始化网关通过后的群按需建立集合，容量满时不挤掉已有群。 */
export function getOrCreateWedMemberState(chatId: number): WedMemberState | undefined {
  let state: WedMemberState | undefined = wedMemberStates.get(chatId);
  if (state !== undefined) return state;
  if (wedMemberStates.size >= STATE_MANAGED_CHAT_LIMIT) return undefined;
  state = { members: new Set(), revision: 0, dirty: false };
  wedMemberStates.set(chatId, state);
  return state;
}

/** init 在联网前接管 DiskIO 已严格验证的全部集合；进程重启不恢复按钮会话。 */
export function hydrateWedMembers(snapshots: ReadonlyMap<number, Set<number>>): void {
  resetWedMemberStates();
  for (const [chatId, members] of snapshots) {
    wedMemberStates.set(chatId, { members, revision: 0, dirty: false });
  }
}

function scheduleWedMemberFlush(immediate: boolean): void {
  if (wedMemberFlushState.timer !== null) {
    if (!immediate || wedMemberFlushState.immediate) return;
    clearTimeout(wedMemberFlushState.timer);
  }
  wedMemberFlushState.immediate = immediate;
  wedMemberFlushState.timer = setTimeout(flushWedMembers, immediate ? 0 : FLUSH_INTERVAL_MS);
  wedMemberFlushState.timer.unref();
}

/** 高频入口只标记实际增删与累计条数；达到统一 DiskIO 阈值后异步生成快照。 */
export function markWedMembersDirty(state: WedMemberState): void {
  state.revision++;
  state.dirty = true;
  wedMemberFlushState.changes++;
  scheduleWedMemberFlush(wedMemberFlushState.changes >= FLUSH_MAX_ENTRIES);
}

function snapshotWedMembers(chatId: number, state: WedMemberState): WedMembersDiskMessage {
  return { type: "wedMembers", chatId, revision: state.revision, members: [...state.members] };
}

/** TTL、累计阈值和停机共用的投递边界；失败保留最终集合，不累计历史快照。 */
export function flushWedMembers(): boolean {
  if (wedMemberFlushState.timer !== null) clearTimeout(wedMemberFlushState.timer);
  wedMemberFlushState.timer = null;
  wedMemberFlushState.immediate = false;
  wedMemberFlushState.changes = 0;
  let accepted: boolean = true;
  for (const [chatId, state] of wedMemberStates) {
    if (!state.dirty) continue;
    if (postDiskIO(snapshotWedMembers(chatId, state))) state.dirty = false;
    else accepted = false;
  }
  if (!accepted) scheduleWedMemberFlush(false);
  return accepted;
}

/** 先删除集合中的 ID，再登记落盘；退群事件和候选核实共用此边界。 */
export function removeWedMember(chatId: number, userId: number): void {
  const state: WedMemberState | undefined = wedMemberStates.get(chatId);
  if (state?.members.delete(userId)) markWedMembersDirty(state);
}

/** DiskIO 重建时重放当前集合；缓冲中较旧修订由统一恢复水位过滤。 */
export function replayWedMembers(transport: DiskIORecoveryTransport): boolean {
  for (const [chatId, state] of wedMemberStates) {
    if (!transport.post(snapshotWedMembers(chatId, state))) return false;
    state.dirty = false;
  }
  return true;
}

onDiskIORespawn("wed members", DISK_IO_RESPAWN_PRIORITIES.WED_MEMBERS, replayWedMembers);
