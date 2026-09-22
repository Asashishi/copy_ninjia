import { describe, expect, test } from "bun:test";
import type { Message } from "grammy/types";
import { visibleSenderChat, visibleSenderId } from "../../packages/users/visibleSender";

const group = { id: -1001, type: "supergroup", title: "群" };

function message(overrides: Record<string, unknown>): Message {
  return { message_id: 1, date: 0, chat: group, ...overrides } as unknown as Message;
}

describe("群内可见发送者", () => {
  test("sender_chat 优先于 from，频道帖退回频道自身，普通用户取 from", () => {
    const mask = { id: -100700, type: "channel", title: "马甲" } as const;
    const channel = { id: -100900, type: "channel", title: "频道" } as const;
    const from = { id: 7, is_bot: false, first_name: "Alice" };

    expect(visibleSenderChat(message({ sender_chat: mask, from }))).toBe(mask);
    expect(visibleSenderId(message({ sender_chat: mask, from }))).toBe(-100700);
    expect(visibleSenderChat(message({ chat: channel }))).toBe(channel);
    expect(visibleSenderId(message({ chat: channel }))).toBe(-100900);
    expect(visibleSenderChat(message({ from }))).toBeUndefined();
    expect(visibleSenderId(message({ from }))).toBe(7);
    expect(visibleSenderId(message({}))).toBeUndefined();
  });
});
