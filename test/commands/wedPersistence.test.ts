import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { pendingWedMemberDeletes, resetWedMemberStates, wedMemberFlushState, wedMemberStates } from "../../packages/cache/main/wedMembers";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../packages/consts/diskIO/appendOnly";
import { getOrCreateWedChat } from "../../packages/commands/wed/chats";
import { observeWedMembers } from "../../packages/commands/wed/members";
import { flushWedMembers, getOrCreateWedMemberState, hydrateWedMembers, purgeWedMembers, removeWedMember, replayWedMembers } from "../../packages/commands/wed/persistence";
import { drainWedRuntime, initWedRuntime } from "../../packages/commands/wed/runtime";
import { teardownWedInChat } from "../../packages/commands/wed";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";
import { wedChats } from "../../packages/cache/main/wed";
import * as diskIO from "../../packages/infra/diskIO";
import type { DiskIORecoveryTransport } from "../../packages/types/diskIO/messages";
import { DiskIORecoveryRevisions } from "../../packages/libs/diskIORecoveryRevisions";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import type { DiskBusinessMessage } from "../../packages/types/diskIO/messages";
import type { DomainFlushOutcome } from "../../packages/types/diskIO/replies";

const post = spyOn(diskIO, "postDiskIO");
const flush = spyOn(diskIO, "flushDiskIODomainOutcome");

function speak(id: number): void {
  const chat = { id: -1001, type: "supergroup" };
  observeWedMembers({ chat, message: { chat, from: { id, is_bot: false }, text: "hi" } } as never);
}

beforeEach(() => {
  initWedRuntime();
  getOrCreateChatState(-1001).isInitEnabled = true;
  post.mockClear();
  post.mockReturnValue(true);
  flush.mockClear();
  flush.mockResolvedValue({ result: "flushed" });
  jest.useFakeTimers();
});

afterEach(() => {
  resetWedMemberStates();
  jest.useRealTimers();
});

test("只有实际增删才标脏，重复发言和不存在的退群 ID 不创建写任务", () => {
  const members: Set<number> = new Set<number>([5974478892]);
  hydrateWedMembers(new Map([[-1001, members]]));
  expect(wedMemberStates.get(-1001)!.members).toBe(members);
  expect(getOrCreateWedChat(-1001)!.members).toBe(members);
  speak(5974478892);
  removeWedMember(-1001, 2);
  jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
  expect(post).not.toHaveBeenCalled();
  expect(wedMemberFlushState.timer).toBeNull();
  expect(wedMemberStates.get(-1001)!.dirty).toBeFalse();
  speak(2);
  expect(wedMemberStates.get(-1001)!.dirty).toBeTrue();
  expect(wedMemberFlushState.changes).toBe(1);
  jest.advanceTimersByTime(FLUSH_INTERVAL_MS - 1);
  speak(2);
  expect(wedMemberFlushState.changes).toBe(1);
  expect(post).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(post).toHaveBeenCalledWith({ type: "wedMembers", chatId: -1001, revision: 1, members: [5974478892, 2] });
  expect(wedMemberStates.get(-1001)!.dirty).toBeFalse();
  jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
  expect(post).toHaveBeenCalledTimes(1);
});

test("累计阈值异步投递完整最终集合，发言路径不创建跨线程快照", () => {
  for (let id = 1; id <= FLUSH_MAX_ENTRIES; id++) speak(id);
  expect(post).not.toHaveBeenCalled();
  expect(wedMemberFlushState.immediate).toBeTrue();
  jest.advanceTimersByTime(0);
  expect(post).toHaveBeenCalledTimes(1);
  const message = post.mock.calls[0]![0];
  expect(message.type).toBe("wedMembers");
  if (message.type !== "wedMembers") throw new Error("missing snapshot");
  expect(message.members).toHaveLength(FLUSH_MAX_ENTRIES);
  removeWedMember(-1001, 1);
  expect(wedMemberStates.get(-1001)!.members.has(1)).toBeFalse();
  expect(message.members[0]).toBe(1);
  jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
  expect(post).toHaveBeenCalledTimes(2);
});

test("投递失败保留 dirty，下一次只重试最新集合，空集合也覆盖旧文件", () => {
  speak(1);
  post.mockReturnValueOnce(false);
  expect(flushWedMembers()).toBeFalse();
  expect(wedMemberStates.get(-1001)!.dirty).toBeTrue();
  removeWedMember(-1001, 1);
  jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
  expect(post).toHaveBeenLastCalledWith({ type: "wedMembers", chatId: -1001, revision: 2, members: [] });
  expect(wedMemberFlushState.timer).toBeNull();
});

test("失权停管只清交互，重开复用成员；停机不等 TTL 即投递", async () => {
  speak(1);
  const chat = getOrCreateWedChat(-1001)!;
  await teardownWedInChat(-1001, "lostAuthority");
  expect(getOrCreateWedChat(-1001)!.members).toBe(chat.members);
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(post).toHaveBeenCalledTimes(1);
  expect(wedMemberFlushState.timer).toBeNull();
});

test("/init disable 与离群删掉奖池并等待 durable 回执，重开是空集合", async () => {
  for (const reason of ["explicitDisable", "departed"] as const) {
    post.mockClear();
    flush.mockClear();
    speak(1);
    expect(wedMemberStates.get(-1001)!.members.has(1)).toBeTrue();
    await teardownWedInChat(-1001, reason);
    expect(wedMemberStates.has(-1001)).toBeFalse();
    expect(post).toHaveBeenLastCalledWith({ type: "deleteWedMembers", chatId: -1001, revision: expect.any(Number) });
    expect(flush).toHaveBeenCalledWith("wedMembers");
    expect(getOrCreateWedChat(-1001)!.members.size).toBe(0);
    wedMemberStates.delete(-1001);
    wedChats.delete(-1001);
  }
});

test("从没发过言的群不为删除白付一轮投递与领域 flush", async () => {
  await teardownWedInChat(-2002, "explicitDisable");
  expect(post).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});

test("投递被拒或领域 flush 失败时删除上抛，不把奖池报成删干净了", async () => {
  speak(1);
  post.mockReturnValueOnce(false);
  await expect(purgeWedMembers(-1001)).rejects.toThrow(/refused the wed member deletion/);
  speak(1);
  flush.mockResolvedValueOnce({ result: "failed" });
  await expect(purgeWedMembers(-1001)).rejects.toThrow(/flush failed/);
});

test("Worker 重放当前集合，统一恢复水位跳过旧 FIFO 快照，恢复失败明确返回", () => {
  speak(1);
  flushWedMembers();
  const old = post.mock.calls[0]![0];
  removeWedMember(-1001, 1);
  const revisions = new DiskIORecoveryRevisions();
  const buffered = new LinkedQueue<DiskBusinessMessage>();
  buffered.push(old);
  const transport: DiskIORecoveryTransport = {
    post: (message): boolean => { revisions.record(message, buffered); return true; },
    ensureLuckReceiptSecret: async (): Promise<never> => { throw new Error("unused"); },
  };
  expect(replayWedMembers(transport)).toBeTrue();
  expect(revisions.covers(old)).toBeTrue();
  expect(replayWedMembers({ ...transport, post: (): boolean => false })).toBeFalse();
});

test("停机投递失败不得报告成功", async () => {
  speak(1);
  post.mockReturnValue(false);
  expect(await drainWedRuntime(100)).toBe("failed");
});

test("删除拒收后保留责任，重复 purge 不依赖重新建奖池", async () => {
  speak(1);
  post.mockReturnValueOnce(false);
  await expect(purgeWedMembers(-1001)).rejects.toThrow("refused");
  const pending = pendingWedMemberDeletes.get(-1001)!;
  expect(wedMemberStates.has(-1001)).toBe(false);
  await purgeWedMembers(-1001);
  expect(post).toHaveBeenNthCalledWith(2, pending);
  expect(pendingWedMemberDeletes.size).toBe(0);
});

test("删除 flush 失败后由重建重放，迟到 durable 回执释放名额", async () => {
  speak(1);
  flush.mockResolvedValueOnce({ result: "failed" });
  await expect(purgeWedMembers(-1001)).rejects.toThrow("flush failed");
  const pending = pendingWedMemberDeletes.get(-1001)!;
  const replayed: DiskBusinessMessage[] = [];
  expect(replayWedMembers({ post: (message): boolean => { replayed.push(message); return true; } } as DiskIORecoveryTransport)).toBe(true);
  expect(replayed).toEqual([pending]);
  expect(replayWedMembers({ post: (): boolean => false, ensureLuckReceiptSecret: async (): Promise<never> => { throw new Error("unused"); } })).toBe(false);
  for (const listener of diskIORuntime.wedMembersDeletedPersistedListeners) {
    listener({ type: "wedMembersDeletedPersisted", chatId: -1001, revision: pending.revision });
  }
  expect(pendingWedMemberDeletes.size).toBe(0);
});

test("重开以空奖池接管旧删除，旧回执不能摘除新一轮删除", async () => {
  speak(1);
  flush.mockResolvedValue({ result: "failed" });
  await expect(purgeWedMembers(-1001)).rejects.toThrow("flush failed");
  const old = pendingWedMemberDeletes.get(-1001)!;
  expect(getOrCreateWedMemberState(-1001)!.members.size).toBe(0);
  expect(wedMemberStates.get(-1001)!.dirty).toBe(true);
  expect(pendingWedMemberDeletes.size).toBe(0);
  flushWedMembers();
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "wedMembers", members: [] }));
  await expect(purgeWedMembers(-1001)).rejects.toThrow("flush failed");
  const current = pendingWedMemberDeletes.get(-1001)!;
  expect(current.revision).toBeGreaterThan(old.revision);
  for (const listener of diskIORuntime.wedMembersDeletedPersistedListeners) {
    listener({ type: "wedMembersDeletedPersisted", chatId: -1001, revision: old.revision });
  }
  expect(pendingWedMemberDeletes.get(-1001)).toBe(current);
});

test("旧 purge 的领域 flush 迟到成功不能结算新一轮删除", async () => {
  speak(1);
  const oldFlush = Promise.withResolvers<DomainFlushOutcome>();
  flush.mockImplementationOnce(() => oldFlush.promise);
  const oldPurge = purgeWedMembers(-1001);
  const old = pendingWedMemberDeletes.get(-1001)!;
  getOrCreateWedMemberState(-1001);
  flush.mockResolvedValueOnce({ result: "failed" });
  await expect(purgeWedMembers(-1001)).rejects.toThrow("flush failed");
  const current = pendingWedMemberDeletes.get(-1001)!;
  expect(current.revision).toBeGreaterThan(old.revision);
  oldFlush.resolve({ result: "flushed" });
  await oldPurge;
  expect(pendingWedMemberDeletes.get(-1001)).toBe(current);
  await purgeWedMembers(-1001);
  expect(pendingWedMemberDeletes.size).toBe(0);
});

test("恢复镜像覆盖旧删除与高修订旧快照，但不覆盖之后新操作", () => {
  const revisions = new DiskIORecoveryRevisions();
  const buffered = new LinkedQueue<DiskBusinessMessage>();
  const oldDelete: DiskBusinessMessage = { type: "deleteWedMembers", chatId: -1001, revision: 1 };
  const oldWrite: DiskBusinessMessage = { type: "wedMembers", chatId: -1001, revision: 100, members: [1] };
  const current: DiskBusinessMessage = { type: "wedMembers", chatId: -1001, revision: 0, members: [2] };
  buffered.push(oldWrite);
  buffered.push(oldDelete);
  revisions.record(current, buffered);
  expect(revisions.covers(oldDelete)).toBe(true);
  expect(revisions.covers(oldWrite)).toBe(true);
  expect(revisions.covers({ type: "wedMembers", chatId: -1001, revision: 0, members: [3] })).toBe(false);
  const nextDelete: DiskBusinessMessage = { type: "deleteWedMembers", chatId: -1001, revision: 2 };
  expect(revisions.covers(nextDelete)).toBe(false);
  buffered.push(current);
  revisions.record(nextDelete, buffered);
  expect(revisions.covers(current)).toBe(true);
  expect(revisions.covers({ type: "wedMembers", chatId: -1001, revision: 0, members: [] })).toBe(false);
});

test("待删群与奖池合计有界，满额时同群仍能重开", async () => {
  flush.mockResolvedValue({ result: "failed" });
  for (let id: number = 1; id <= STATE_MANAGED_CHAT_LIMIT; id++) {
    expect(getOrCreateWedMemberState(-id)).toBeDefined();
    await expect(purgeWedMembers(-id)).rejects.toThrow("flush failed");
  }
  expect(pendingWedMemberDeletes.size).toBe(STATE_MANAGED_CHAT_LIMIT);
  expect(getOrCreateWedMemberState(-10000)).toBeUndefined();
  expect(getOrCreateWedMemberState(-1)).toBeDefined();
  expect(pendingWedMemberDeletes.size + wedMemberStates.size).toBe(STATE_MANAGED_CHAT_LIMIT);
});
