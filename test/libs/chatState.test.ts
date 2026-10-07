import { describe, expect, test } from "bun:test";
import type { ChatState } from "../../packages/types/chatState";
import { QUIET_MAX_DURATION_MS } from "../../packages/consts/commands";
import { normalizeChatState } from "../../packages/libs/chatState";
import { botPermissions } from "../helpers/botPermissions";
import { chatStateOf } from "../helpers/chatState";

describe("chat state normalization", () => {
  test("回收过期静默，同时保留已确认的非管理员权限快照", () => {
    const knownNonAdmin = botPermissions({
      isAdministrator: false,
      canManageChat: false,
    });
    const state: ChatState = chatStateOf({
      quietUntil: 999,
      botPermissions: knownNonAdmin,
      title: "Test Group",
    });

    expect(normalizeChatState(state, 1_000)).toEqual(chatStateOf({
      botPermissions: knownNonAdmin,
      title: "Test Group",
    }));
  });

  test("保留所有显式开启状态、未来静默及过期 lockdown 恢复资料", () => {
    const state: ChatState = chatStateOf({
      quietUntil: 1_001,
      lockdown: { phase: "active", intentId: 1, originalPermissions: {}, announced: true, expiresAt: 900 },
      isAIChatEnabled: true,
      isTranslationEnabled: true,
      isFloodControlEnabled: true,
      isInitEnabled: true,
      isProxySendEnabled: true,
    });

    expect(normalizeChatState(state, 1_000)).toEqual(chatStateOf({
      quietUntil: 1_001,
      lockdown: { phase: "active", intentId: 1, originalPermissions: {}, announced: true, expiresAt: 900 },
      isAIChatEnabled: true,
      isTranslationEnabled: true,
      isFloodControlEnabled: true,
      isInitEnabled: true,
      isProxySendEnabled: true,
    }));
  });

  test("小幅回拨落在容差内时顶格静默原样保留", () => {
    // `/quiet 15` 写下的 quietUntil - now 恰好等于上限；主机时钟往回跳 1 毫秒仍落在容差内，字段原样保留。
    const state: ChatState = chatStateOf({ quietUntil: 1_000 + QUIET_MAX_DURATION_MS });
    expect(normalizeChatState(state, 999)).toEqual(chatStateOf({ quietUntil: 1_000 + QUIET_MAX_DURATION_MS }));
  });

  test("墙钟回拨造成超出最大静默时长的未来截止时间被收敛到上限，而不是删掉", () => {
    // 删字段不可逆（内存与 SQLite 行一起消失）；收敛保住静默本身，同时保证它不晚于上限结束。
    const state: ChatState = chatStateOf({ quietUntil: 1_000 + QUIET_MAX_DURATION_MS + 60 * 60_000 });
    expect(normalizeChatState(state, 1_000)).toEqual(chatStateOf({ quietUntil: 1_000 + QUIET_MAX_DURATION_MS }));
  });

  test("真的到点的静默照常回收", () => {
    expect(normalizeChatState(chatStateOf({ quietUntil: 1_000 }), 1_000)).toEqual(chatStateOf());
  });
});
