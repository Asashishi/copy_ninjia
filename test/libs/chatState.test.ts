import { describe, expect, test } from "bun:test";
import type { ChatState } from "../../packages/types";
import { normalizeChatState, normalizeChatStateEntry } from "../../packages/libs/chatState";

describe("chat state normalization", () => {
  test("删除缺省等价字段和过期静默，同时保留有意义的 false", () => {
    const state: ChatState = {
      quietUntil: 999,
      isAIChatEnabled: false,
      isJATranslationEnabled: false,
      isFloodControlEnabled: false,
      isInitEnabled: false,
      isProxySendEnabled: false,
      botIsAdmin: false,
      title: "Test Group",
    };

    expect(normalizeChatState(state, 1_000)).toEqual({
      botIsAdmin: false,
      title: "Test Group",
    });
  });

  test("保留所有显式开启状态、未来静默及过期 lockdown 恢复资料", () => {
    const state: ChatState = {
      quietUntil: 1_001,
      lockdown: { phase: "active", intentId: 1, originalPermissions: {}, expiresAt: 900 },
      isAIChatEnabled: true,
      isJATranslationEnabled: true,
      isFloodControlEnabled: true,
      isInitEnabled: true,
      isProxySendEnabled: true,
    };

    expect(normalizeChatState(state, 1_000)).toEqual({
      quietUntil: 1_001,
      lockdown: { phase: "active", intentId: 1, originalPermissions: {}, expiresAt: 900 },
      isAIChatEnabled: true,
      isJATranslationEnabled: true,
      isFloodControlEnabled: true,
      isInitEnabled: true,
      isProxySendEnabled: true,
    });
  });

  test("最后一个有效字段消失后回收 Map 条目", () => {
    const states = new Map<number, ChatState>([[-1001, { isProxySendEnabled: false }]]);
    expect(normalizeChatStateEntry(states, -1001, 1_000)).toBeUndefined();
    expect(states.has(-1001)).toBe(false);
  });

  test("墙钟回拨造成超出最大静默时长的未来截止时间会被回收", () => {
    const state: ChatState = { quietUntil: 1_000 + 16 * 60_000 };
    expect(normalizeChatState(state, 1_000)).toEqual({});
  });
});
