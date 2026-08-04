import { describe, expect, test } from "bun:test";
import type { ChatState } from "../../packages/types";
import { QUIET_MAX_DURATION_MS } from "../../packages/consts/commands";
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

  test("小幅回拨落在容差内时顶格静默原样保留", () => {
    // `/quiet 15` 写下的 quietUntil - now 恰好等于上限，容差为零的话主机时钟往回
    // 跳 1 毫秒就让它当场失效、字段还被这个 normalizer 一并抹掉。
    const state: ChatState = { quietUntil: 1_000 + QUIET_MAX_DURATION_MS };
    expect(normalizeChatState(state, 999)).toEqual({ quietUntil: 1_000 + QUIET_MAX_DURATION_MS });
  });

  test("墙钟回拨造成超出最大静默时长的未来截止时间被收敛到上限，而不是删掉", () => {
    // 删字段是不可逆的：静默从内存和 state.json 一起消失，时钟回正也找不回来。
    // 收敛保住静默本身，同时保证它不晚于上限结束。
    const state: ChatState = { quietUntil: 1_000 + QUIET_MAX_DURATION_MS + 60 * 60_000 };
    expect(normalizeChatState(state, 1_000)).toEqual({ quietUntil: 1_000 + QUIET_MAX_DURATION_MS });
  });

  test("真的到点的静默照常回收", () => {
    expect(normalizeChatState({ quietUntil: 1_000 }, 1_000)).toEqual({});
  });
});
