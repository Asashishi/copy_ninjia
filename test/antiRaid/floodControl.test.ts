import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import { buildFloodCandidate } from "../../packages/antiRaid/floodControl";
import { chatStates } from "../../packages/cache/main/storage";
import { whitelistConfigCache } from "../../packages/cache/main/whitelist";
import { parseWhitelistConfig } from "../../packages/config/whitelist";

const BOT_ID: number = 99;

function groupMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -1001, type: "supergroup", title: "群" },
    from: { id: 7, is_bot: false, first_name: "刷屏怪" },
    text: "spam",
    ...overrides,
  } as Message;
}

beforeEach(() => {
  chatStates.clear();
  chatStates.set(-1001, { isFloodControlEnabled: true });
  whitelistConfigCache.current = parseWhitelistConfig({});
});

afterEach(() => {
  chatStates.clear();
  whitelistConfigCache.current = null;
});

describe("刷屏计数的主线程投递门禁", () => {
  test("按群缺省关闭，只有显式开启后才投递", () => {
    chatStates.clear();
    expect(buildFloodCandidate(groupMessage(), BOT_ID)).toBeUndefined();

    chatStates.set(-1001, { isFloodControlEnabled: true });
    expect(buildFloodCandidate(groupMessage(), BOT_ID)?.type).toBe("floodCandidate");
  });

  test("超级群里的真实用户收敛成投递，标签按可见发送者算好", () => {
    expect(buildFloodCandidate(groupMessage(), BOT_ID)).toEqual({
      type: "floodCandidate",
      chatId: -1001,
      userId: 7,
      label: "刷屏怪",
    });

    // 有公开用户名时优先用 @username，与其它播报同源（users/userLabel.ts）。
    const named = buildFloodCandidate(
      groupMessage({ from: { id: 7, is_bot: false, first_name: "刷屏怪", username: "noisy" } } as Partial<Message>),
      BOT_ID
    );
    expect(named?.label).toBe("@noisy");
  });

  test("只认超级群：restrictChatMember 在普通群和私聊里根本不适用", () => {
    expect(buildFloodCandidate(
      groupMessage({ chat: { id: -1002, type: "group", title: "普通群" } } as Partial<Message>),
      BOT_ID
    )).toBeUndefined();
    expect(buildFloodCandidate(
      groupMessage({ chat: { id: 7, type: "private", first_name: "私聊" } } as Partial<Message>),
      BOT_ID
    )).toBeUndefined();
  });

  test("频道马甲与匿名管理员没有可禁言的成员身份，一律不投递", () => {
    expect(buildFloodCandidate(
      groupMessage({ sender_chat: { id: -1009, type: "channel", title: "马甲" } } as Partial<Message>),
      BOT_ID
    )).toBeUndefined();
    // 拿当前群当皮套的匿名管理员：sender_chat.id === chat.id。
    expect(buildFloodCandidate(
      groupMessage({ sender_chat: { id: -1001, type: "supergroup", title: "群" } } as Partial<Message>),
      BOT_ID
    )).toBeUndefined();
  });

  test("机器人自己、没有发送者、超级管理员和获授豁免的白名单身份都不计数", () => {
    expect(buildFloodCandidate(
      groupMessage({ from: { id: BOT_ID, is_bot: true, first_name: "本天才" } } as Partial<Message>),
      BOT_ID
    )).toBeUndefined();
    expect(buildFloodCandidate(groupMessage({ from: undefined }), BOT_ID)).toBeUndefined();
    // preload 注入的 SUPER_ADMIN_USER_ID 是 1。
    expect(buildFloodCandidate(
      groupMessage({ from: { id: 1, is_bot: false, first_name: "超管" } } as Partial<Message>),
      BOT_ID
    )).toBeUndefined();

    whitelistConfigCache.current = parseWhitelistConfig({ "7": {} });
    expect(buildFloodCandidate(groupMessage(), BOT_ID)).toBeUndefined();
    whitelistConfigCache.current = parseWhitelistConfig({
      "7": { isCanBypassFloodControl: false },
    });
    expect(buildFloodCandidate(groupMessage(), BOT_ID)?.userId).toBe(7);
  });
});
