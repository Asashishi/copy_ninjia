import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import { ANTI_RAID_PER_MINUTE_LIMIT, RESTORE_RETRY_MS } from "../../../packages/consts/antiRaid/lockdown";
import { waitUntil } from "../../helpers/waitUntil";

const CHAT_ID: number = -1005;
let hold: "announcement" | "prepare" | "commitRead" | "write" | undefined;
let gate: PromiseWithResolvers<void>;
let entered: boolean = false;
let acknowledge: boolean = true;
let inviteAllowed: boolean = true;
let queries: number = 0;
let notices: number = 0;
let restoreAttempts: number = 0;
let failedRestores: number = 0;
const writes: boolean[] = [];
const sent: number[] = [];
const deleted: number[] = [];

mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  fetchAdminIds: async (): Promise<ReadonlySet<number>> => new Set(),
  freshAdminIds: (): ReadonlySet<number> => new Set(),
}));
mock.module("../../../packages/workers/antiRaid/lockdownPersistence", () => ({
  publishLockdownState: (chatId: number): void => {
    if (!acknowledge) return;
    const state = lockdownEntries.get(chatId)?.state;
    if (state === undefined || (state.kind === "applying" && state.stage === "preparing")) return;
    queueMicrotask((): void => handleLockdownPersisted({ type: "lockdownPersisted", chatId, phase: state.kind, intentId: state.intentId }));
  },
}));
mock.module("../../../packages/infra/telegram/lockdownPermissions", () => ({
  restoreLockdownInvitePermission: async (): Promise<void> => {
    restoreAttempts++;
    if (failedRestores-- > 0) throw new Error("mock restore failure");
    inviteAllowed = true;
    writes.push(true);
  },
}));
mock.module("../../../packages/infra/telegram", () => ({
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> => { deleted.push(messageId); return true; },
  sendMessage: async (): Promise<number> => {
    const id: number = 100 + ++notices;
    if (hold === "announcement" && notices === 1) { entered = true; await gate.promise; }
    sent.push(id);
    return id;
  },
  telegramApi: {
    getChat: async (): Promise<{ permissions: ChatPermissions }> => {
      queries++;
      if ((hold === "prepare" && queries === 1) || (hold === "commitRead" && queries === 2)) {
        entered = true;
        await gate.promise;
      }
      return { permissions: { can_invite_users: inviteAllowed } };
    },
    setChatPermissions: async (): Promise<void> => {
      if (hold === "write") { entered = true; await gate.promise; }
      inviteAllowed = false;
      writes.push(false);
    },
  },
}));
mock.module("../../../packages/infra/telegram/workerClient", () => ({ sendTemporaryMessageFromMain: async (): Promise<undefined> => undefined }));
mock.module("../../../packages/workers/antiRaid/taskTracker", () => ({
  trackAntiRaidTask: ({ task }: { task: Promise<void> }): Promise<void> => task,
  antiRaidDispatchSignal: (): AbortSignal => new AbortController().signal,
}));
const { lockdownEntries, lockdownApiChains } = await import("../../../packages/cache/workers/antiRaid/lockdown");
const { recordJoin, adoptLockdowns, deactivateLockdownChat, handleLockdownPersisted, handleLockdownPersistFailed, stopLockdownRuntime } = await import("../../../packages/workers/antiRaid/lockdownRuntime");

function trigger(): void {
  for (let index: number = 0; index <= ANTI_RAID_PER_MINUTE_LIMIT; index++) recordJoin(CHAT_ID, Date.now());
}

async function drain(): Promise<void> {
  for (let round: number = 0; round < 30; round++) {
    await Promise.resolve();
    const pending: Promise<void> | undefined = lockdownApiChains.get(CHAT_ID);
    if (pending === undefined) return;
    await pending;
  }
  throw new Error("Lockdown API chain did not drain");
}

beforeEach((): void => {
  gate = Promise.withResolvers<void>();
  hold = undefined;
  entered = false;
  acknowledge = true;
  inviteAllowed = true;
  queries = notices = restoreAttempts = failedRestores = 0;
  writes.length = sent.length = deleted.length = 0;
  spyOn(globalThis, "postMessage").mockImplementation((): void => {});
});
afterEach((): void => { stopLockdownRuntime(); jest.useRealTimers(); jest.restoreAllMocks(); });

test.each([false, true])("补公告落盘失败时保留在途提交的恢复责任，恢复首次失败=%s", async (retry: boolean): Promise<void> => {
  hold = "write";
  acknowledge = false;
  failedRestores = retry ? 1 : 0;
  adoptLockdowns([{ chatId: CHAT_ID, phase: "applying", intentId: 7, originalPermissions: { can_invite_users: true }, announced: false, persisted: true, remainingMs: 0 }]);
  await waitUntil((): boolean => entered);
  if (retry) jest.useFakeTimers();
  handleLockdownPersistFailed({ type: "lockdownPersistFailed", chatId: CHAT_ID, phase: "applying", intentId: 7 });
  expect(lockdownEntries.get(CHAT_ID)?.state.kind).toBe("restoring");
  handleLockdownPersistFailed({ type: "lockdownPersistFailed", chatId: CHAT_ID, phase: "applying", intentId: 7 });
  gate.resolve();
  await drain();
  if (retry) {
    expect(lockdownEntries.get(CHAT_ID)?.retryTimer).toBeDefined();
    jest.advanceTimersByTime(RESTORE_RETRY_MS);
    await drain();
  }
  expect(writes).toEqual([false, true]);
  expect(restoreAttempts).toBe(retry ? 2 : 1);
  expect(lockdownEntries.has(CHAT_ID)).toBe(false);
});

test("初次落盘失败且未派发提交时不写权限", async (): Promise<void> => {
  acknowledge = false;
  trigger();
  await drain();
  const state = lockdownEntries.get(CHAT_ID)!.state;
  if (state.kind !== "applying" || state.stage !== "prepared") throw new Error("Missing prepared state");
  handleLockdownPersistFailed({ type: "lockdownPersistFailed", chatId: CHAT_ID, phase: "applying", intentId: state.intentId });
  await drain();
  expect(writes).toEqual([]);
  expect(lockdownEntries.has(CHAT_ID)).toBe(false);
});

test.each([false, true])("旧轮公告迟到，新轮仍拥有自己的公告，旧发送失败=%s", async (failed: boolean): Promise<void> => {
  hold = "announcement";
  trigger();
  await waitUntil((): boolean => entered);
  deactivateLockdownChat(CHAT_ID);
  trigger();
  if (failed) gate.reject(new Error("mock old announcement failure"));
  else gate.resolve();
  await drain();
  expect(lockdownEntries.get(CHAT_ID)?.state.announcementMessageId).toBe(102);
  deactivateLockdownChat(CHAT_ID);
  await drain();
  expect(deleted.toSorted()).toEqual(sent.toSorted());
  expect(inviteAllowed).toBe(true);
});

test.each([false, true])("旧轮权限预备查询迟到不推进新轮，失败=%s", async (failed: boolean): Promise<void> => {
  hold = "prepare";
  trigger();
  await waitUntil((): boolean => entered);
  deactivateLockdownChat(CHAT_ID);
  trigger();
  if (failed) gate.reject(new Error("mock old query failure"));
  else gate.resolve();
  await drain();
  expect(queries).toBe(3);
  expect(writes).toEqual([false]);
  expect(lockdownEntries.get(CHAT_ID)?.state.kind).toBe("active");
  deactivateLockdownChat(CHAT_ID);
  await drain();
  expect(deleted.toSorted()).toEqual(sent.toSorted());
});

test("解除发生在提交查询期间时，查询返回不能再收紧权限", async (): Promise<void> => {
  hold = "commitRead";
  trigger();
  await waitUntil((): boolean => entered);
  deactivateLockdownChat(CHAT_ID);
  gate.resolve();
  await drain();
  expect(writes).toEqual([true]);
  expect(lockdownEntries.has(CHAT_ID)).toBe(false);
});

test("公告执行前已解除时不再发送旧公告或读取旧权限", async (): Promise<void> => {
  trigger();
  deactivateLockdownChat(CHAT_ID);
  await drain();
  expect(sent).toEqual([]);
  expect(queries).toBe(0);
});
