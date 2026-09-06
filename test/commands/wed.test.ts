import { resetWedMemberStates } from "../../packages/cache/main/wedMembers";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Chat, User } from "grammy/types";
import { GrammyError } from "grammy";
import type { Mock } from "bun:test";
import type { CurrentAvatar } from "../../packages/types/telegram";

mock.module("../../packages/infra/logger", () => ({ logger: { error(): void {}, warn(): void {}, info(): void {}, log(): void {} } }));
const avatar: Mock<(user: User, signal: AbortSignal) => Promise<string | Uint8Array | undefined>> =
  mock(async (_user: User, _signal: AbortSignal): Promise<Uint8Array> => new Uint8Array([1, 2, 3]));
mock.module("../../packages/infra/telegram/avatar/read", () => ({
  async readCurrentAvatar(target: User, signal: AbortSignal): Promise<CurrentAvatar | undefined> {
    const photo: string | Uint8Array | undefined = await avatar(target, signal);
    return photo === undefined ? undefined : { identity: target, photo };
  },
}));

const { bot } = await import("../../packages/infra/telegram/mainClient");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { pendingMessageDeletions } = await import("../../packages/cache/perThread/messageDeletion");
const { resetPendingMessageDeletions } = await import("../../packages/infra/telegram");
const { wedChats } = await import("../../packages/cache/main/wed");
const { getOrCreateWedChat } = await import("../../packages/commands/wed/chats");
const { handleWedCommand, handleWedCallback, teardownWedInChat } = await import("../../packages/commands/wed");
const { WED_BUTTON_TEXTS, WED_MEMBER_LIMIT, WED_SESSION_LIMIT, WED_TEXTS } = await import("../../packages/consts/wed");
const { renderWedCaption } = await import("../../packages/commands/wed/rendering");

const chat = { id: -1001, type: "supergroup", title: "群" } as const;
const channel: Chat.ChannelChat = { id: -2002, type: "channel", title: "频道🌸", username: "current_channel" };
const actor: User = { id: 1, first_name: "小🌸", is_bot: false };
const partner: User = { id: 2, first_name: "<b>群友</b>", is_bot: false };
const nextPartner: User = { id: 3, first_name: "另一个人", is_bot: false };
const member = mock(async (_chatId: number, id: number): Promise<any> => ({ status: "member", user: id === 2 ? partner : nextPartner }));
let sentId: number = 100;
const photo = mock(async (..._args: any[]): Promise<any> => ({ message_id: ++sentId, chat, date: 1, photo: [] }));
const edit = mock(async (..._args: any[]): Promise<any> => true);
const markup = mock(async (..._args: any[]): Promise<any> => true);
const remove = mock(async (..._args: any[]): Promise<any> => true);
const notice = mock(async (..._args: any[]): Promise<any> => ({ message_id: ++sentId, chat, date: 1 }));
const answer = mock(async (..._args: any[]): Promise<any> => true);
const setProfile = mock(async (..._args: any[]): Promise<any> => true);

function command(overrides: Record<string, unknown> = {}): never {
  const msg = { message_id: 10, chat, from: actor, is_topic_message: true, message_thread_id: 77 };
  return { chat, msg, message: msg, msgId: 10, from: actor, match: "", ...overrides } as never;
}

function callback(action: string, overrides: Record<string, unknown> = {}): never {
  const session = wedChats.get(chat.id)?.sessions.get(actor.id);
  return { callbackQuery: {
    id: "callback", data: `wed:1:${session?.targetId ?? 2}:${action}`, from: actor,
    message: { message_id: session?.messageId ?? 101, chat, date: 1 }, ...overrides,
  } } as never;
}

beforeEach(() => {
  wedChats.clear();
  resetWedMemberStates();
  resetPendingMessageDeletions();
  sentId = 100;
  for (const fn of [member, avatar, photo, edit, markup, remove, notice, answer, setProfile]) fn.mockClear();
  avatar.mockImplementation(async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]));
  member.mockImplementation(async (_chatId: number, id: number): Promise<any> => ({ status: "member", user: id === 2 ? partner : nextPartner }));
  photo.mockImplementation(async (): Promise<any> => ({ message_id: ++sentId, chat, date: 1, photo: [] }));
  edit.mockImplementation(async (): Promise<any> => true);
  remove.mockImplementation(async (): Promise<any> => true);
  Object.assign(bot.api, { getChatMember: member, sendPhoto: photo, editMessageMedia: edit,
    editMessageReplyMarkup: markup, deleteMessage: remove, sendMessage: notice, answerCallbackQuery: answer,
    setMyProfilePhoto: setProfile });
  telegramApiState.current = bot.api as never;
  const state = getOrCreateWedChat(chat.id)!;
  state.members.add(1);
  state.members.add(2);
});

afterEach(() => {
  expect(setProfile).not.toHaveBeenCalled();
  resetPendingMessageDeletions();
  wedChats.clear();
  resetWedMemberStates();
});

describe("/wed 图片和按钮交互", () => {
  test.each([actor, { id: 777000, is_bot: true }, undefined])("频道不能发起，也不使用 from 占位用户 %j", async (from) => {
    await handleWedCommand(command({ from, msg: { message_id: 10, chat, from, sender_chat: channel } }));
    expect(notice.mock.calls.at(-1)![1]).toBe(WED_TEXTS.groupOnly);
    expect(member).not.toHaveBeenCalled();
    expect(avatar).not.toHaveBeenCalled();
    expect(photo).not.toHaveBeenCalled();
    expect(wedChats.get(chat.id)!.sessions.size).toBe(0);
    expect(pendingMessageDeletions.size).toBe(1);
  });

  test("按钮拒绝非用户 ID，不查询频道权限或改变现有结果", async () => {
    await handleWedCommand(command());
    member.mockClear();
    for (const [actorId, targetId] of [[channel.id, 2], [1, channel.id]]) {
      for (const action of ["marry", "remove", "change"]) {
        await handleWedCallback(callback(action, { data: `wed:${actorId}:${targetId}:${action}` }));
        expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.expired);
      }
    }
    expect(member).not.toHaveBeenCalled();
    expect(markup).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeFalse();
  });

  test("回复命令、继承话题，头像在上、图注在下，单排三按钮不挂 30 秒清理", async () => {
    await handleWedCommand(command());
    const [chatId, input, options] = photo.mock.calls[0]!;
    expect(chatId).toBe(chat.id);
    expect(input.fileData).toEqual(new Uint8Array([1, 2, 3]));
    expect(options.caption).toBe("小🌸，你的群友老婆是 <b>群友<／b>!");
    expect(options.caption_entities).toEqual([
      { type: "text_mention", offset: 0, length: actor.first_name.length, user: actor },
      { type: "text_mention", offset: "小🌸，你的群友老婆是 ".length, length: "<b>群友<／b>".length, user: partner },
    ]);
    expect(avatar.mock.calls[0]![0]).toBe(partner);
    expect(options.parse_mode).toBeUndefined();
    expect(options.show_caption_above_media).toBeUndefined();
    expect(options.reply_parameters.message_id).toBe(10);
    expect(options.message_thread_id).toBe(77);
    expect(options.reply_markup.inline_keyboard).toHaveLength(1);
    expect(options.reply_markup.inline_keyboard[0].map((b: any) => b.text))
      .toEqual([WED_BUTTON_TEXTS.remove, WED_BUTTON_TEXTS.marry, WED_BUTTON_TEXTS.change]);
    expect(pendingMessageDeletions.size).toBe(0);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.targetId).toBe(2);
  });

  test("可复用头像直接发送 file_id，更换沿用图注、按钮与清理边界", async (): Promise<void> => {
    avatar.mockImplementation(async (user: User): Promise<string> => `avatar-${user.id}`);
    await handleWedCommand(command());
    expect(photo.mock.calls[0]![1]).toBe("avatar-2");
    expect(photo.mock.calls[0]![2].reply_parameters.message_id).toBe(10);
    expect(photo.mock.calls[0]![2].message_thread_id).toBe(77);
    await handleWedCallback(callback("marry"));
    wedChats.get(chat.id)!.members.add(3);
    await handleWedCallback(callback("change"));
    expect(edit.mock.calls[0]![2].media).toBe("avatar-3");
    expect(edit.mock.calls[0]![2].caption).toContain(nextPartner.first_name);
    expect(edit.mock.calls[0]![3].reply_markup.inline_keyboard[0][1].text).toBe(WED_BUTTON_TEXTS.marry);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.targetId).toBe(3);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeFalse();
    expect(pendingMessageDeletions.size).toBe(0);
    expect(setProfile).not.toHaveBeenCalled();
    await handleWedCallback(callback("remove"));
    expect(remove).toHaveBeenCalledWith(chat.id, 101);
    expect(wedChats.get(chat.id)!.sessions.size).toBe(0);
  });

  test("file_id 更换失败保留旧目标和确认状态", async (): Promise<void> => {
    avatar.mockImplementation(async (user: User): Promise<string> => `avatar-${user.id}`);
    await handleWedCommand(command());
    await handleWedCallback(callback("marry"));
    wedChats.get(chat.id)!.members.add(3);
    edit.mockImplementationOnce(async (): Promise<never> => { throw new Error("fixture edit failed"); });
    await handleWedCallback(callback("change"));
    expect(wedChats.get(chat.id)!.sessions.get(1)!.targetId).toBe(2);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeTrue();
    expect(remove).not.toHaveBeenCalled();
    expect(notice.mock.calls.at(-1)![1]).toBe(WED_TEXTS.failed);
  });

  test("确认幂等，确认后换一只就地换图文并恢复确认按钮，移除释放状态", async () => {
    await handleWedCommand(command());
    await handleWedCallback(callback("marry"));
    await handleWedCallback(callback("marry"));
    expect(markup).toHaveBeenCalledTimes(1);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeTrue();
    wedChats.get(chat.id)!.members.add(3);
    await handleWedCallback(callback("change"));
    expect(edit.mock.calls[0]![1]).toBe(101);
    expect(edit.mock.calls[0]![2].media.fileData).toEqual(new Uint8Array([1, 2, 3]));
    expect(edit.mock.calls[0]![2].caption).toContain(nextPartner.first_name);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.targetId).toBe(3);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeFalse();
    expect(photo).toHaveBeenCalledTimes(1);
    await handleWedCallback(callback("remove"));
    expect(remove).toHaveBeenCalledWith(chat.id, 101);
    expect(wedChats.get(chat.id)!.sessions.size).toBe(0);
  });

  test("再次 /wed 重抽，旧结果删除，新图片回复新命令", async () => {
    await handleWedCommand(command());
    await handleWedCommand(command({ msgId: 11 }));
    expect(remove).toHaveBeenCalledWith(chat.id, 101);
    expect(photo).toHaveBeenCalledTimes(2);
    expect(photo.mock.calls[1]![2].reply_parameters.message_id).toBe(11);
    expect(wedChats.get(chat.id)!.sessions.size).toBe(1);
  });

  test("重开时旧图片删除失败，原会话和确认状态仍可操作", async () => {
    await handleWedCommand(command());
    await handleWedCallback(callback("marry"));
    const previous = wedChats.get(chat.id)!.sessions.get(1)!;
    remove.mockImplementationOnce(async (): Promise<any> => { throw new Error("delete failed"); });
    await handleWedCommand(command({ msgId: 11 }));
    expect(wedChats.get(chat.id)!.sessions.get(1)).toBe(previous);
    expect(previous.confirmed).toBeTrue();
    expect(previous.busy).toBeFalse();
    expect(previous.controller.signal.aborted).toBeFalse();
    expect(photo).toHaveBeenCalledTimes(1);
    await handleWedCallback(callback("remove"));
    expect(wedChats.get(chat.id)!.sessions.size).toBe(0);
  });

  test("确认回执丢失后 Telegram 报内容未变，仍收敛为已确认", async () => {
    await handleWedCommand(command());
    markup.mockImplementationOnce(async (): Promise<any> => {
      throw new GrammyError("not modified", { ok: false, error_code: 400, description: "Bad Request: message is not modified" }, "editMessageReplyMarkup", {});
    });
    await handleWedCallback(callback("marry"));
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeTrue();
    expect(notice).not.toHaveBeenCalled();
  });

  test("更换后旧目标的按钮不能确认、移除或再次更换新结果", async () => {
    await handleWedCommand(command());
    wedChats.get(chat.id)!.members.add(3);
    await handleWedCallback(callback("change"));
    for (const action of ["marry", "remove", "change"]) {
      await handleWedCallback(callback(action, { data: `wed:1:2:${action}` }));
      expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.updated);
    }
    expect(markup).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(wedChats.get(chat.id)!.sessions.get(1)!.confirmed).toBeFalse();
    await handleWedCallback(callback("marry"));
    expect(markup).toHaveBeenCalledTimes(1);
  });

  test("他人、伪造消息、跨群、非法动作和重启后的旧按钮均不能改变结果", async () => {
    await handleWedCommand(command());
    await handleWedCallback(callback("change", { from: partner }));
    expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.ownerOnly);
    await handleWedCallback(callback("remove", { message: { message_id: 999, chat, date: 1 } }));
    await handleWedCallback(callback("remove", { message: { message_id: 101, chat: { ...chat, id: -2000 }, date: 1 } }));
    await handleWedCallback(callback("bogus"));
    await handleWedCallback(callback("remove", { message: { message_id: 101, chat, date: 0 } }));
    expect(remove).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    wedChats.clear();
    resetWedMemberStates();
    await handleWedCallback(callback("remove"));
    expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.expired);
    expect(await handleWedCallback({ callbackQuery: { data: "qa:next" } } as never)).toBeFalse();
  });

  test("不存在替换候选时保留图片；无头像、离群和查询失败不发错误图片", async () => {
    await handleWedCommand(command());
    await handleWedCallback(callback("change"));
    expect(edit).not.toHaveBeenCalled();
    expect(notice.mock.calls.at(-1)![1]).toBe(WED_TEXTS.unavailable);
    avatar.mockImplementation(async (): Promise<undefined> => undefined);
    await handleWedCommand(command());
    expect(remove).not.toHaveBeenCalled();
    expect(wedChats.get(chat.id)!.sessions.get(1)!.messageId).toBe(101);
    member.mockImplementation(async (): Promise<any> => ({ status: "left", user: partner }));
    await handleWedCommand(command());
    expect(wedChats.get(chat.id)!.members.has(2)).toBeFalse();
    expect(photo).toHaveBeenCalledTimes(1);
  });

  test("发送、编辑、删除失败均归一化，失败更换不改变原结果，删除可重试", async () => {
    photo.mockImplementationOnce(async (): Promise<any> => { throw new Error("send failed"); });
    await handleWedCommand(command());
    expect(wedChats.get(chat.id)!.sessions.size).toBe(0);
    await handleWedCommand(command());
    wedChats.get(chat.id)!.members.add(3);
    edit.mockImplementationOnce(async (): Promise<any> => { throw new Error("edit failed"); });
    await handleWedCallback(callback("change"));
    expect(wedChats.get(chat.id)!.sessions.get(1)!.targetId).toBe(2);
    remove.mockImplementationOnce(async (): Promise<any> => { throw new Error("delete failed"); });
    await handleWedCallback(callback("remove"));
    expect(wedChats.get(chat.id)!.sessions.size).toBe(1);
    await handleWedCallback(callback("remove"));
    expect(wedChats.get(chat.id)!.sessions.size).toBe(0);
  });

  test("在途请求占住会话；重复点击和命令不并发下载，群 teardown 取消且不发送迟到图片", async () => {
    let finish!: (bytes: Uint8Array) => void;
    avatar.mockImplementationOnce((_user: User, _signal: AbortSignal): Promise<Uint8Array> => new Promise((resolve) => { finish = resolve; }));
    const pending = handleWedCommand(command());
    for (let i = 0; i < 50 && avatar.mock.calls.length === 0; i++) await Promise.resolve();
    expect(avatar).toHaveBeenCalledTimes(1);
    await handleWedCommand(command());
    expect(notice.mock.calls.at(-1)![1]).toBe(WED_TEXTS.busy);
    const signal = avatar.mock.calls[0]![1];
    await teardownWedInChat(chat.id);
    expect(signal.aborted).toBeTrue();
    finish(new Uint8Array([1]));
    await pending;
    expect(photo).not.toHaveBeenCalled();
    expect(wedChats.has(chat.id)).toBeFalse();
  });

  test("远端已发送但 teardown 先到时仍登记并删除迟到的结果", async () => {
    let finish!: (message: any) => void;
    photo.mockImplementationOnce((): Promise<any> => new Promise((resolve) => { finish = resolve; }));
    const pending = handleWedCommand(command());
    for (let i = 0; i < 50 && photo.mock.calls.length === 0; i++) await Promise.resolve();
    expect(photo).toHaveBeenCalledTimes(1);
    await teardownWedInChat(chat.id);
    finish({ message_id: 200, chat, date: 1, photo: [] });
    await pending;
    expect(remove).toHaveBeenCalledWith(chat.id, 200);
    expect(wedChats.has(chat.id)).toBeFalse();
  });

  test("更换进行中拒绝重复按钮；群关闭阻止迟到的编辑并删除原图片", async () => {
    await handleWedCommand(command());
    wedChats.get(chat.id)!.members.add(3);
    let finish!: (bytes: Uint8Array) => void;
    avatar.mockImplementationOnce((): Promise<Uint8Array> => new Promise((resolve) => { finish = resolve; }));
    const pending = handleWedCallback(callback("change"));
    for (let i = 0; i < 50 && avatar.mock.calls.length < 2; i++) await Promise.resolve();
    expect(avatar).toHaveBeenCalledTimes(2);
    await handleWedCallback(callback("change"));
    expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.busy);
    await teardownWedInChat(chat.id);
    finish(new Uint8Array([2]));
    await pending;
    expect(edit).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(chat.id, 101);
  });

  test("查询故障保留候选；查询发现机器人则移除；不可用头像探测次数有界", async () => {
    member.mockImplementationOnce(async (): Promise<any> => { throw new Error("query failed"); });
    await handleWedCommand(command());
    expect(wedChats.get(chat.id)!.members.has(2)).toBeTrue();
    expect(photo).not.toHaveBeenCalled();
    member.mockImplementationOnce(async (): Promise<any> => ({ status: "member", user: { ...partner, is_bot: true } }));
    await handleWedCommand(command());
    expect(wedChats.get(chat.id)!.members.has(2)).toBeFalse();
    for (let id = 2; id <= WED_MEMBER_LIMIT; id++) wedChats.get(chat.id)!.members.add(id);
    member.mockImplementation(async (_chatId: number, id: number): Promise<any> => ({ status: "member", user: { ...partner, id } }));
    avatar.mockImplementation(async (): Promise<undefined> => undefined);
    await handleWedCommand(command());
    expect(avatar).toHaveBeenCalledTimes(8);
    expect(new Set(member.mock.calls.slice(2).map((call) => call[1])).size).toBe(8);
  });

  test("普通 teardown 删除结果；会话满额不淘汰别人的按钮", async () => {
    await handleWedCommand(command());
    const state = wedChats.get(chat.id)!;
    const session = state.sessions.get(1)!;
    for (let id = 2; id <= WED_SESSION_LIMIT; id++) state.sessions.set(id, session);
    await handleWedCommand(command({ from: { ...actor, id: 9999 } }));
    expect(notice.mock.calls.at(-1)![1]).toBe(WED_TEXTS.full);
    state.sessions.clear();
    state.sessions.set(1, session);
    await teardownWedInChat(chat.id);
    expect(remove).toHaveBeenCalledWith(chat.id, 101);
  });

  test("空缓存、匿名、私聊和参数均给出提示；昵称实体偏移可覆盖 emoji", async () => {
    wedChats.get(chat.id)!.members.delete(2);
    await handleWedCommand(command());
    expect(notice.mock.calls.at(-1)![1]).toBe(WED_TEXTS.empty);
    await handleWedCommand(command({ msg: { sender_chat: chat } }));
    await handleWedCommand(command({ chat: { id: 1, type: "private" } }));
    await handleWedCommand(command({ match: "bad" }));
    expect(photo).not.toHaveBeenCalled();
    const caption = renderWedCaption(actor, partner);
    expect(caption.text.slice(caption.entities[1]!.offset, caption.entities[1]!.offset + caption.entities[1]!.length)).toBe("<b>群友<／b>");
    expect(pendingMessageDeletions.size).toBeGreaterThan(0);
  });
});
