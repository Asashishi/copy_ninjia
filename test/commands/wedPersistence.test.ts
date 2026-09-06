import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { resetWedMemberStates, wedMemberFlushState, wedMemberStates } from "../../packages/cache/main/wedMembers";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../packages/consts/diskIO/appendOnly";
import { getOrCreateWedChat } from "../../packages/commands/wed/chats";
import { observeWedMembers } from "../../packages/commands/wed/members";
import { flushWedMembers, hydrateWedMembers, removeWedMember, replayWedMembers } from "../../packages/commands/wed/persistence";
import { drainWedRuntime, initWedRuntime } from "../../packages/commands/wed/runtime";
import { teardownWedInChat } from "../../packages/commands/wed";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";
import * as diskIO from "../../packages/infra/diskIO";
import type { DiskIORecoveryTransport } from "../../packages/types/diskIO/messages";
import { DiskIORecoveryRevisions } from "../../packages/libs/diskIORecoveryRevisions";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import type { DiskBusinessMessage } from "../../packages/types/diskIO/messages";

const post = spyOn(diskIO, "postDiskIO");

function speak(id: number): void {
  const chat = { id: -1001, type: "supergroup" };
  observeWedMembers({ chat, message: { chat, from: { id, is_bot: false }, text: "hi" } } as never);
}

beforeEach(() => {
  initWedRuntime();
  getOrCreateChatState(-1001).isInitEnabled = true;
  post.mockClear();
  post.mockReturnValue(true);
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

test("群 teardown 只清交互，重开复用成员；停机不等 TTL 即投递", async () => {
  speak(1);
  const chat = getOrCreateWedChat(-1001)!;
  await teardownWedInChat(-1001);
  expect(getOrCreateWedChat(-1001)!.members).toBe(chat.members);
  expect(await drainWedRuntime(100)).toBe("flushed");
  expect(post).toHaveBeenCalledTimes(1);
  expect(wedMemberFlushState.timer).toBeNull();
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
