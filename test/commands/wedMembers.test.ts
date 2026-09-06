import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ChatMember } from "grammy/types";
import { wedChats } from "../../packages/cache/main/wed";
import { resetWedMemberStates, wedMemberStates } from "../../packages/cache/main/wedMembers";
import { getOrCreateWedChat } from "../../packages/commands/wed/chats";
import { observeWedMembers } from "../../packages/commands/wed/members";
import { WED_CHAT_CACHE_MAX_ENTRIES, WED_MEMBER_LIMIT } from "../../packages/consts/wed";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { isPresentMember } from "../../packages/libs/chatMember";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";

function message(id: number, chatId: number = -1001, overrides: Record<string, unknown> = {}): never {
  const chat = { id: chatId, type: "supergroup" };
  return { chat, message: { chat, from: { id, first_name: "群友", is_bot: false }, text: "hi", ...overrides } } as never;
}

beforeEach(() => {
  wedChats.clear();
  resetWedMemberStates();
  getOrCreateChatState(-1001).isInitEnabled = true;
  getOrCreateChatState(-2000).isInitEnabled = true;
});

afterEach(resetWedMemberStates);

test("首次 /init 特许放行仍不提前建缓存，启用后才记录成员", () => {
  getOrCreateChatState(-1001).isInitEnabled = undefined;
  observeWedMembers(message(1, -1001, { text: "/init enable" }));
  expect(wedMemberStates.has(-1001)).toBeFalse();
  getOrCreateChatState(-1001).isInitEnabled = false;
  observeWedMembers(message(1));
  expect(wedMemberStates.has(-1001)).toBeFalse();
  getOrCreateChatState(-1001).isInitEnabled = true;
  observeWedMembers(message(1));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([1]);
});

test("每群独立 15 万个 ID，满额保留已有成员，退群后继续接纳", () => {
  for (let id = 1; id <= WED_MEMBER_LIMIT; id++) observeWedMembers(message(id));
  const members = wedMemberStates.get(-1001)!.members;
  observeWedMembers(message(1));
  observeWedMembers(message(WED_MEMBER_LIMIT + 1));
  expect(members).toBeInstanceOf(Set);
  expect(members.size).toBe(150_000);
  expect(members.has(1)).toBeTrue();
  expect(members.has(2)).toBeTrue();
  expect(members.has(WED_MEMBER_LIMIT + 1)).toBeFalse();
  expect([...members.keys()].at(-1)).toBe(WED_MEMBER_LIMIT);
  observeWedMembers(message(2, -2000));
  expect(wedMemberStates.get(-2000)!.members.size).toBe(1);
  observeWedMembers(message(1, -1001, { left_chat_member: { id: 2 } }));
  observeWedMembers(message(WED_MEMBER_LIMIT + 1));
  expect(members.has(2)).toBeFalse();
  expect(members.has(WED_MEMBER_LIMIT + 1)).toBeTrue();
  expect(members.size).toBe(WED_MEMBER_LIMIT);
});

test("排除机器人、匿名群身份、私聊、回复和转发里的用户，只缓存实际发言者", () => {
  observeWedMembers(message(1, -1001, { from: { id: 1, is_bot: true } }));
  observeWedMembers(message(1, -1001, { sender_chat: { id: -1001, type: "supergroup" } }));
  observeWedMembers({ chat: { id: 1, type: "private" }, message: { from: { id: 1 } } } as never);
  expect(wedMemberStates.size).toBe(0);
  observeWedMembers(message(1, -1001, { reply_to_message: { from: { id: 2 } }, forward_origin: { sender_user: { id: 3 } } }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([1]);
  observeWedMembers(message(5, -1001, { new_chat_members: [{ id: 6 }] }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([1]);
});

test("频道发言、匿名服务用户和自动转发均不进入候选，也不创建群缓存", () => {
  const sender = { id: -2002, type: "channel", title: "频道" };
  observeWedMembers(message(1, -1001, { sender_chat: sender, from: { id: 777000, is_bot: true } }));
  observeWedMembers(message(1, -1001, { sender_chat: sender }));
  observeWedMembers(message(1, -1001, { sender_chat: { ...sender, id: -2003 }, is_automatic_forward: true }));
  observeWedMembers(message(1, -1001, { sender_chat: { ...sender, id: -2004 }, from: undefined }));
  expect(wedMemberStates.size).toBe(0);
  observeWedMembers(message(2));
  observeWedMembers(message(1, -1001, { sender_chat: sender }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([2]);
});

test("离群服务消息和 chat_member 移除 ID，restricted 只有 is_member 为真才算在群", () => {
  observeWedMembers(message(1));
  observeWedMembers(message(2));
  observeWedMembers(message(3, -1001, { left_chat_member: { id: 1 } }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([2]);
  observeWedMembers({ chat: { id: -1001, type: "supergroup" }, chatMember: { new_chat_member: { user: { id: 2 }, status: "restricted", is_member: false } } } as never);
  expect(wedMemberStates.get(-1001)!.members.size).toBe(0);
  expect(isPresentMember({ status: "restricted", is_member: true } as ChatMember)).toBeTrue();
  expect(isPresentMember({ status: "kicked" } as ChatMember)).toBeFalse();
  expect(isPresentMember({ status: "administrator" } as ChatMember)).toBeTrue();
});

test("成员权威表满额时拒绝建立新群交互，已有群仍可命中", () => {
  for (let id = 1; id <= STATE_MANAGED_CHAT_LIMIT; id++) getOrCreateWedChat(-id);
  expect(getOrCreateWedChat(-1000)).toBeUndefined();
  expect(wedChats.size).toBe(STATE_MANAGED_CHAT_LIMIT);
  expect(getOrCreateWedChat(-1)).toBe(wedChats.get(-1));
});

test("群交互缓存容量为 1024，命中刷新 LRU，未命中不淘汰", () => {
  const first = getOrCreateWedChat(-1)!;
  const second = getOrCreateWedChat(-2)!;
  for (let id = 3; id <= WED_CHAT_CACHE_MAX_ENTRIES; id++) {
    wedChats.set(-id, { controller: new AbortController(), members: new Set(), sessions: new Map() });
  }
  expect(wedChats.size).toBe(1_024);
  expect(getOrCreateWedChat(-1)).toBe(first);
  expect(wedChats.get(-10_000)).toBeUndefined();
  expect(wedChats.size).toBe(1_024);
  const newest = getOrCreateWedChat(-10_000)!;
  expect(newest).toBeDefined();
  expect(wedChats.size).toBe(1_024);
  expect(wedChats.has(-1)).toBeTrue();
  expect(wedChats.has(-2)).toBeFalse();
  expect(second.controller.signal.aborted).toBeTrue();
  expect(first.controller.signal.aborted).toBeFalse();
  expect(wedMemberStates.get(-2)!.members).toBe(second.members);
});
