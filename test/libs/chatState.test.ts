import { describe, expect, test } from "bun:test";
import type { ChatState } from "../../src/types";
import { normalizeChatState, normalizeChatStateEntry } from "../../src/libs/chatState";

describe("chat state normalization", () => {
  test("删除缺省等价字段和过期静默，同时保留有意义的 false", () => {
    const state: ChatState = {
      quietUntil: 999,
      isUseAIChat: false,
      isJATranslationEnabled: false,
      isInit: false,
      isUseProxySend: false,
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
      lockdown: { originalPermissions: {}, expiresAt: 900 },
      isUseAIChat: true,
      isJATranslationEnabled: true,
      isInit: true,
      isUseProxySend: true,
    };

    expect(normalizeChatState(state, 1_000)).toEqual({
      quietUntil: 1_001,
      lockdown: { originalPermissions: {}, expiresAt: 900 },
      isUseAIChat: true,
      isJATranslationEnabled: true,
      isInit: true,
      isUseProxySend: true,
    });
  });

  test("最后一个有效字段消失后回收 Map 条目", () => {
    const states = new Map<number, ChatState>([[-1001, { isUseProxySend: false }]]);
    expect(normalizeChatStateEntry(states, -1001, 1_000)).toBeUndefined();
    expect(states.has(-1001)).toBe(false);
  });
});
