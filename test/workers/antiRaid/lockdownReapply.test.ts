/** 私密模式纠偏（reapplyLockdownRestriction）：只在 RECONCILING 下重读权限并关闭邀请，结果回投状态机。 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ChatFullInfo, ChatPermissions } from "grammy/types";
import type { LockdownMachineEvent, LockdownState } from "../../../packages/types/states/lockdown";
import { loggerStub } from "../../helpers/loggerMock";

const CHAT_ID: number = -1007;
const permissionWrites: ChatPermissions[] = [];
const loggedErrors: string[] = [];
let chatInfo: Partial<ChatFullInfo> = {};
let getChatCalls: number = 0;
let onGetChat: (() => void) | undefined;

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(message: string): void { loggedErrors.push(message); } }),
}));
mock.module("../../../packages/infra/telegram", () => ({
  deleteMessage: async (): Promise<boolean> => true,
  sendMessage: async (): Promise<number> => 1,
  telegramApi: {
    getChat: async (): Promise<Partial<ChatFullInfo>> => {
      getChatCalls++;
      onGetChat?.();
      return chatInfo;
    },
    setChatPermissions: async (_chatId: number, permissions: ChatPermissions): Promise<true> => {
      permissionWrites.push(permissions);
      return true;
    },
  },
}));
mock.module("../../../packages/workers/antiRaid/taskTracker", () => ({
  trackAntiRaidTask: ({ task }: { task: Promise<void> }): Promise<void> => task,
}));

const { lockdownApiChains, lockdownEntries } = await import("../../../packages/cache/workers/antiRaid/lockdown");
const { reapplyLockdownRestriction } = await import("../../../packages/workers/antiRaid/lockdownApi");

const dispatched: LockdownMachineEvent[] = [];

function reconcilingState(): LockdownState {
  return {
    kind: "reconciling",
    originalPermissions: { can_invite_users: true },
    intentId: 1,
    reapplyAfterPersist: false,
    announced: false,
    announcementPending: false,
    announcementMessageId: undefined,
  };
}

async function drain(): Promise<void> {
  for (let round: number = 0; round < 10; round++) {
    const pending: Promise<void> | undefined = lockdownApiChains.get(CHAT_ID);
    if (pending === undefined) return;
    await pending;
  }
}

function lockdownEntry(): Parameters<typeof lockdownEntries.set>[1] {
  return {
    state: reconcilingState(),
    restoreTimer: undefined,
    retryTimer: undefined,
    restoreAt: undefined,
    restorePermanentFailures: 0,
  };
}

beforeEach((): void => {
  getChatCalls = 0;
  onGetChat = undefined;
  permissionWrites.length = 0;
  loggedErrors.length = 0;
  dispatched.length = 0;
  lockdownEntries.set(CHAT_ID, lockdownEntry());
});

afterEach((): void => {
  lockdownEntries.delete(CHAT_ID);
});

test("重读到权限时只关闭邀请、保留其它字段，并回投成功", async () => {
  chatInfo = { permissions: { can_invite_users: true, can_send_messages: true } };
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(permissionWrites).toEqual([{ can_invite_users: false, can_send_messages: true }]);
  expect(dispatched).toEqual([{ type: "reapplyResult", ok: true }]);
});

test("getChat 缺 permissions 时不写权限、记错误并回投失败，由状态机安排重试", async () => {
  chatInfo = {};
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(permissionWrites).toEqual([]);
  expect(dispatched).toEqual([{ type: "reapplyResult", ok: false }]);
  expect(loggedErrors).toHaveLength(1);
});

test("条目已不在 RECONCILING 时不重读权限、不写权限也不回投", async () => {
  lockdownEntries.delete(CHAT_ID);
  chatInfo = { permissions: { can_invite_users: true } };
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(getChatCalls).toBe(0);
  expect(permissionWrites).toEqual([]);
  expect(dispatched).toEqual([]);
});

test("getChat 期间条目被新一代替换时丢弃迟到结果，不写权限也不回投", async () => {
  chatInfo = { permissions: { can_invite_users: true } };
  onGetChat = (): void => { lockdownEntries.set(CHAT_ID, lockdownEntry()); };
  reapplyLockdownRestriction(CHAT_ID, (_chatId: number, event: LockdownMachineEvent): void => { dispatched.push(event); });
  await drain();

  expect(getChatCalls).toBe(1);
  expect(permissionWrites).toEqual([]);
  expect(dispatched).toEqual([]);
});
