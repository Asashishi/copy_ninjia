import { describe, expect, test } from "bun:test";
import {
  assertTelegramChatId,
  decodeChatStateData,
  encodeChatStateData,
} from "../../packages/database/codec/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

describe("chat_states codec", () => {
  test("完整权限、功能开关和 lockdown 严格往返", () => {
    const permissions: BotChatPermissions = botPermissions({
      canDeleteMessages: true,
      canRestrictMembers: true,
      canPinMessages: true,
    });
    const text: string = encodeChatStateData({
      isInitEnabled: true,
      isFloodControlEnabled: true,
      botPermissions: permissions,
      lockdown: {
        phase: "reconciling",
        intentId: 2,
        announced: false,
        originalPermissions: { can_invite_users: true },
        expiresAt: 3_000,
      },
    }, "chat_states[-1001].data");
    expect(decodeChatStateData(text, "chat_states[-1001].data")).toEqual({
      quietUntil: undefined,
      lockdown: {
        phase: "reconciling",
        intentId: 2,
        announced: false,
        originalPermissions: { can_invite_users: true },
        expiresAt: 3_000,
      },
      isAIChatEnabled: undefined,
      isJATranslationEnabled: undefined,
      isAdDetectEnabled: undefined,
      isFloodControlEnabled: true,
      isAntiRaidEnabled: undefined,
      isInitEnabled: true,
      botPermissions: permissions,
      title: undefined,
      isProxySendEnabled: undefined,
    });
  });

  test("封锁公告的 message ID 必须能原样往返：重启接管的那一轮靠它删公告", () => {
    const text: string = encodeChatStateData({
      lockdown: {
        phase: "active",
        intentId: 5,
        announced: true,
        announcementMessageId: 900,
        originalPermissions: { can_invite_users: true },
        expiresAt: 9_000,
      },
    }, "chat_states[-1001].data");
    expect(decodeChatStateData(text, "chat_states[-1001].data").lockdown).toEqual({
      phase: "active",
      intentId: 5,
      announced: true,
      announcementMessageId: 900,
      originalPermissions: { can_invite_users: true },
      expiresAt: 9_000,
    });
  });

  test("权限快照必须完整，非管理员时其它权限必须全 false", () => {
    const incomplete: Record<string, boolean> = {
      ...botPermissions({ canDeleteMessages: true }),
    };
    delete incomplete.canManageTopics;
    expect(() => decodeChatStateData(
      JSON.stringify({ botPermissions: incomplete }),
      "database/storage.sqlite:chat_states[-1001].data"
    )).toThrow("$.botPermissions.canManageTopics");

    const nonAdmin: BotChatPermissions = botPermissions({
      isAdministrator: false,
      canManageChat: false,
    });
    expect(() => decodeChatStateData(
      JSON.stringify({
        botPermissions: { ...nonAdmin, canDeleteMessages: true },
      }),
      "database/storage.sqlite:chat_states[-1001].data"
    )).toThrow("$.botPermissions.canDeleteMessages");
  });

  test("旧 botIsAdmin、未知字段、空状态和非法 lockdown 一律拒绝", () => {
    expect(() => decodeChatStateData(
      JSON.stringify({ botIsAdmin: true }),
      "chat_states[-1001].data"
    )).toThrow("supported chat-state fields");
    expect(() => decodeChatStateData("{}", "chat_states[-1001].data"))
      .toThrow("a non-empty chat-state object");
    // 公告在占位落地那一刻就发出，因此 applying 阶段也可以是「已公告」。
    expect(() => decodeChatStateData(
      JSON.stringify({
        lockdown: {
          phase: "applying",
          intentId: 1,
          announced: true,
          announcementMessageId: 900,
          originalPermissions: {},
          expiresAt: 2_000,
        },
      }),
      "chat_states[-1001].data"
    )).not.toThrow();
    // message ID 只可能来自一次成功的发送。
    expect(() => decodeChatStateData(
      JSON.stringify({
        lockdown: {
          phase: "active",
          intentId: 1,
          announced: false,
          announcementMessageId: 900,
          originalPermissions: {},
          expiresAt: 2_000,
        },
      }),
      "chat_states[-1001].data"
    )).toThrow("$.lockdown.announcementMessageId");
    expect(() => decodeChatStateData(
      JSON.stringify({
        lockdown: {
          phase: "active",
          intentId: 1,
          announced: true,
          announcementMessageId: 0,
          originalPermissions: {},
          expiresAt: 2_000,
        },
      }),
      "chat_states[-1001].data"
    )).toThrow("$.lockdown.announcementMessageId");
  });

  test("chat 主键必须是负安全整数的群或频道 ID", () => {
    expect(() => assertTelegramChatId(0, "chat_states")).toThrow("$.chatId");
    expect(() => assertTelegramChatId(1, "chat_states")).toThrow("$.chatId");
    expect(() => assertTelegramChatId(Number.MAX_SAFE_INTEGER + 1, "chat_states"))
      .toThrow("$.chatId");
    expect(() => assertTelegramChatId(-1001, "chat_states")).not.toThrow();
  });
});
