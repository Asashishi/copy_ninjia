import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatMember, ChatPermissions } from "grammy/types";
import type { CronAction, CronSendNeeds, CronTask, CronTaskSchedule } from "../../packages/types/cron";
import type { ChatState } from "../../packages/types/chatState";

/** 每个群的机器人成员身份与默认权限；缺省表示查询失败。 */
const members: Map<number, ChatMember> = new Map<number, ChatMember>();
const defaults: Map<number, ChatPermissions | undefined> = new Map<number, ChatPermissions | undefined>();
const chatStates: Map<number, ChatState> = new Map<number, ChatState>();
const getChatMember = mock(async (chatId: number, _userId: number): Promise<ChatMember> => {
  const member: ChatMember | undefined = members.get(chatId);
  if (member === undefined) throw new Error("Bad Request: chat not found");
  return member;
});
const getChat = mock(async (chatId: number): Promise<unknown> => ({ id: chatId, type: "supergroup", permissions: defaults.get(chatId) }));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: { botInfo: { id: 42 }, api: { getChatMember, getChat } },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({ getChatStateCache: () => chatStates }));

const { memberCanSend, resolveCronGroupTargets, sendNeedsOf } = await import("../../packages/cron/targets");

const BOT = { id: 42, is_bot: true, first_name: "bot" };
const TEXT_ONLY: CronSendNeeds = { text: true, photos: false, documents: false };
const EVERYTHING: CronSendNeeds = { text: true, photos: true, documents: true };

function schedule(actions: readonly CronAction[], cancelled: boolean = false): CronTaskSchedule {
  const task: CronTask = {
    name: "all-groups",
    chatTargets: { kind: "all" },
    cron: "* * * * *",
    timeZone: "Asia/Tokyo",
    randomInterval: undefined,
    justOnce: false,
    actions,
  };
  return { task, job: null, timer: null, cancelled };
}

beforeEach(() => {
  members.clear();
  defaults.clear();
  chatStates.clear();
  getChatMember.mockClear();
  getChat.mockClear();
});

describe("chat_id: [\"all\"] 与 [\"except\", ...] 的发送权限", () => {
  test("动作类型决定需要哪几项发送权限", () => {
    expect(sendNeedsOf([{ type: "send_message", content: "hi" }])).toEqual(TEXT_ONLY);
    expect(sendNeedsOf([
      { type: "send_image", content: undefined, source: { kind: "random", directory: null }, isBlurred: false },
      { type: "send_file", content: undefined, source: { kind: "url", url: "https://e.com/r.pdf" } },
    ])).toEqual({ text: false, photos: true, documents: true });
  });

  test("按机器人的成员身份判定：群主、管理员、被限制、离开与被踢", () => {
    expect(memberCanSend({ status: "creator", user: BOT, is_anonymous: false }, EVERYTHING)).toBe(true);
    const admin = { status: "administrator", user: BOT, can_be_edited: false } as unknown as ChatMember;
    expect(memberCanSend(admin, EVERYTHING)).toBe(true);
    // 频道管理员没有发帖权时不可发。
    expect(memberCanSend({ ...admin, can_post_messages: false } as ChatMember, TEXT_ONLY)).toBe(false);
    const restricted = {
      status: "restricted", user: BOT, is_member: true, until_date: 0,
      can_send_messages: true, can_send_photos: false, can_send_documents: true,
    } as unknown as ChatMember;
    expect(memberCanSend(restricted, TEXT_ONLY)).toBe(true);
    expect(memberCanSend(restricted, EVERYTHING)).toBe(false);
    expect(memberCanSend({ ...restricted, is_member: false } as ChatMember, TEXT_ONLY)).toBe(false);
    expect(memberCanSend({ status: "left", user: BOT }, TEXT_ONLY)).toBe(false);
    expect(memberCanSend({ status: "kicked", user: BOT, until_date: 0 }, TEXT_ONLY)).toBe(false);
    expect(memberCanSend({ status: "member", user: BOT }, TEXT_ONLY)).toBeUndefined();
  });

  test("只看已启用的群，按 chat id 升序；普通成员读群默认权限，缺权限与查询失败都计入跳过", async () => {
    chatStates.set(-3, { isInitEnabled: true });
    chatStates.set(-1, { isInitEnabled: true });
    chatStates.set(-2, { isInitEnabled: false });
    chatStates.set(-5, { isInitEnabled: true });
    chatStates.set(-4, { isInitEnabled: true });
    members.set(-5, { status: "administrator", user: BOT } as unknown as ChatMember);
    members.set(-4, { status: "member", user: BOT });
    defaults.set(-4, { can_send_messages: true, can_send_photos: false });
    members.set(-3, { status: "member", user: BOT });
    defaults.set(-3, { can_send_messages: true, can_send_photos: true });
    // -1 查询失败（chat not found）。

    const targets = await resolveCronGroupTargets(schedule([
      { type: "send_message", content: "hi" },
      { type: "send_image", content: undefined, source: { kind: "urls", urls: ["https://e.com/a.png"] }, isBlurred: false },
    ]), [], new AbortController().signal);
    expect(targets).toEqual({ chatIds: [-5, -3], skipped: 2 });
    expect(getChatMember.mock.calls.map((call: [number, number]): number => call[0])).toEqual([-5, -4, -3, -1]);
    // 群主与管理员不必再读默认权限。
    expect(getChat.mock.calls.map((call: [number]): number => call[0])).toEqual([-4, -3]);
  });

  test("`except` 列出的群不查询也不计入跳过", async () => {
    for (const chatId of [-3, -2, -1]) {
      chatStates.set(chatId, { isInitEnabled: true });
      members.set(chatId, { status: "creator", user: BOT, is_anonymous: false });
    }
    // -1 本可发送，但被排除；-2 不在名单里照常查询。
    expect(await resolveCronGroupTargets(schedule([{ type: "send_message", content: "hi" }]), [-1, -9], new AbortController().signal))
      .toEqual({ chatIds: [-3, -2], skipped: 0 });
    expect(getChatMember.mock.calls.map((call: [number, number]): number => call[0])).toEqual([-3, -2]);
  });

  test("取消后不再查询后面的群", async () => {
    chatStates.set(-1, { isInitEnabled: true });
    chatStates.set(-2, { isInitEnabled: true });
    const controller: AbortController = new AbortController();
    controller.abort();
    expect(await resolveCronGroupTargets(schedule([{ type: "send_message", content: "hi" }]), [], controller.signal))
      .toEqual({ chatIds: [], skipped: 0 });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  test("任务被热重载撤销后不再查询后面的群", async () => {
    chatStates.set(-1, { isInitEnabled: true });
    chatStates.set(-2, { isInitEnabled: true });
    expect(await resolveCronGroupTargets(schedule([{ type: "send_message", content: "hi" }], true), [], new AbortController().signal))
      .toEqual({ chatIds: [], skipped: 0 });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  test("查询途中被撤销时停在当前群，已查完的部分照常返回", async () => {
    for (const chatId of [-3, -2, -1]) {
      chatStates.set(chatId, { isInitEnabled: true });
      members.set(chatId, { status: "creator", user: BOT, is_anonymous: false });
    }
    const pending: CronTaskSchedule = schedule([{ type: "send_message", content: "hi" }]);
    // 第一个群查完就撤销，后面两个群不再查询。
    getChatMember.mockImplementationOnce(async (chatId: number): Promise<ChatMember> => {
      pending.cancelled = true;
      return members.get(chatId)!;
    });
    expect(await resolveCronGroupTargets(pending, [], new AbortController().signal))
      .toEqual({ chatIds: [-3], skipped: 0 });
    expect(getChatMember).toHaveBeenCalledTimes(1);
  });
});
