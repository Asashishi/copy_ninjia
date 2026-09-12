import { pendingWedMemberDeletes, wedMemberDeleteCounter, wedMemberFlushState, wedMemberStates, resetWedMemberStates } from "../../cache/main/wedMembers";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { flushDiskIODomainOutcome, onDiskIORespawn, postDiskIO } from "../../infra/diskIO";
import { onWedMembersDeletedPersisted } from "../../infra/diskIO/observers";
import type { DiskIORecoveryTransport, WedMembersDeleteDiskMessage, WedMembersDiskMessage } from "../../types/diskIO/messages";
import type { DomainFlushOutcome, WedMembersDeletedPersistedReply } from "../../types/diskIO/replies";
import type { WedMemberState } from "../../types/wed";

/** 初始化网关通过后的群按需建立集合，容量满时不挤掉已有群。 */
export function getOrCreateWedMemberState(chatId: number): WedMemberState | undefined {
  let state: WedMemberState | undefined = wedMemberStates.get(chatId);
  if (state !== undefined) return state;
  const pending: WedMembersDeleteDiskMessage | undefined = pendingWedMemberDeletes.get(chatId);
  if (pending === undefined && wedMemberStates.size + pendingWedMemberDeletes.size >= STATE_MANAGED_CHAT_LIMIT) return undefined;
  state = { members: new Set(), revision: pending === undefined ? 0 : pending.revision + 1, dirty: pending !== undefined };
  wedMemberStates.set(chatId, state);
  if (pending !== undefined) {
    pendingWedMemberDeletes.delete(chatId);
    scheduleWedMemberFlush(true);
  }
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
  for (const message of pendingWedMemberDeletes.values()) {
    if (!postDiskIO(message)) accepted = false;
  }
  for (const [chatId, state] of wedMemberStates) {
    if (!state.dirty) continue;
    if (postDiskIO(snapshotWedMembers(chatId, state))) state.dirty = false;
    else accepted = false;
  }
  if (!accepted) scheduleWedMemberFlush(false);
  return accepted;
}

/**
 * 摘掉奖池后保留独立删除责任；durable 回执/领域 flush 确认后才清理。
 * 无奖池也无待删记录时直接返回；失败可由重复 teardown、timer 或 Worker 重放继续。
 * 新奖池以空快照接管旧删除，迟到回执只结算自身编号；约束见 docs/cn/04-invariants.md。
 */
export async function purgeWedMembers(chatId: number): Promise<void> {
  let message: WedMembersDeleteDiskMessage | undefined = pendingWedMemberDeletes.get(chatId);
  if (wedMemberStates.delete(chatId)) {
    message = { type: "deleteWedMembers", chatId, revision: ++wedMemberDeleteCounter.current };
    pendingWedMemberDeletes.set(chatId, message);
  }
  if (message === undefined) return;
  if (!postDiskIO(message)) {
    scheduleWedMemberFlush(false);
    throw new Error(`Disk I/O refused the wed member deletion for chat ${chatId}.`);
  }
  const outcome: DomainFlushOutcome = await flushDiskIODomainOutcome("wedMembers");
  if (outcome.result !== "flushed") {
    throw new Error(
      `Failed to delete the wed member snapshot for chat ${chatId}: flush ${outcome.result}.`
    );
  }
  if (pendingWedMemberDeletes.get(chatId) === message) pendingWedMemberDeletes.delete(chatId);
}

/** 先删除集合中的 ID，再登记落盘；退群事件、候选核实和每日复核共用此边界。 */
export function removeWedMember(chatId: number, userId: number): void {
  const state: WedMemberState | undefined = wedMemberStates.get(chatId);
  if (state?.members.delete(userId)) markWedMembersDirty(state);
}

/** DiskIO 重建时重放待删责任与最终集合；恢复层仅覆盖重放时 FIFO 中的同群旧操作。 */
export function replayWedMembers(transport: DiskIORecoveryTransport): boolean {
  for (const message of pendingWedMemberDeletes.values()) {
    if (!transport.post(message)) return false;
  }
  for (const [chatId, state] of wedMemberStates) {
    if (!transport.post(snapshotWedMembers(chatId, state))) return false;
    state.dirty = false;
  }
  return true;
}

onDiskIORespawn("wed members", DISK_IO_RESPAWN_PRIORITIES.WED_MEMBERS, replayWedMembers);
onWedMembersDeletedPersisted((reply: WedMembersDeletedPersistedReply): void => {
  if (pendingWedMemberDeletes.get(reply.chatId)?.revision === reply.revision) {
    pendingWedMemberDeletes.delete(reply.chatId);
  }
});
