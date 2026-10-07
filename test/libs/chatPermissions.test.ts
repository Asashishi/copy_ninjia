import { describe, expect, test } from "bun:test";
import type { ChatPermissions } from "grammy/types";
import { CHAT_PERMISSION_KEYS } from "../../packages/consts/storage";
import { normalizeChatPermissions } from "../../packages/libs/chatPermissions";

describe("chat permissions normalization", () => {
  test("丢掉平台新增的未知字段，已知布尔字段原样保留", () => {
    // Telegram 单方面给 getChat().permissions 加一个字段就是这个形态；未知字段不进 ChatState.lockdown，落盘自检不因它失败。
    const fromTelegram = {
      can_invite_users: true,
      can_send_messages: false,
      can_send_confetti: true,
    } as unknown as ChatPermissions;

    expect(normalizeChatPermissions(fromTelegram)).toEqual({
      can_invite_users: true,
      can_send_messages: false,
    });
  });

  test("非布尔值一律丢弃，不猜真假", () => {
    const malformed = {
      can_invite_users: "true",
      can_send_polls: null,
      can_pin_messages: 1,
      can_change_info: true,
    } as unknown as ChatPermissions;

    expect(normalizeChatPermissions(malformed)).toEqual({ can_change_info: true });
  });

  test("已经合法的权限集原样通过，缺省字段不被补成 false", () => {
    // 缺省字段不补 false：「Telegram 没说」与「明确禁止」是两回事。
    expect(normalizeChatPermissions({})).toEqual({});
    const full: ChatPermissions = {};
    for (const key of CHAT_PERMISSION_KEYS) Reflect.set(full, key, true);
    expect(normalizeChatPermissions(full)).toEqual(full);
  });
});
