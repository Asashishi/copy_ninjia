/**
 * 覆盖 packages/aiChat/availability.ts 的判定入口：进程侧前提就绪
 * （aiChatConfigReadiness）与本群 `isAIChatEnabled` 的合取，逐组合覆盖
 * 真值表四格。约束见 docs/cn/04-invariants.md。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatState } from "../../packages/types/chatState";
import { createChatState } from "../../packages/libs/chatState";

const CHAT_ID: number = -1001;

/** 逐用例可改的进程侧就绪结论与群状态。 */
const readiness: { ok: boolean } = { ok: true };
const chatState: Partial<ChatState> = {};

mock.module("../../packages/config/readiness", () => ({
  aiChatConfigReadiness: (): { ok: boolean } => readiness,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Partial<ChatState> => chatState,
}));

const { isAiChatActiveIn, isAiChatConfigured } =
  await import("../../packages/aiChat/availability");

beforeEach(() => {
  readiness.ok = true;
  chatState.isAIChatEnabled = undefined;
});

describe("AI 闲聊可用性", () => {
  test("进程侧前提直接取 config readiness 的结论", () => {
    expect(isAiChatConfigured()).toBeTrue();
    readiness.ok = false;
    expect(isAiChatConfigured()).toBeFalse();
  });

  test("两半都成立才算本群在跑", () => {
    readiness.ok = true;
    chatState.isAIChatEnabled = true;
    expect(isAiChatActiveIn(CHAT_ID)).toBeTrue();
  });

  test("进程侧前提缺失时，即使群开着也不算在跑", () => {
    readiness.ok = false;
    chatState.isAIChatEnabled = true;
    expect(isAiChatActiveIn(CHAT_ID)).toBeFalse();
  });

  test("群没开时不算在跑，前提齐备也一样", () => {
    readiness.ok = true;
    chatState.isAIChatEnabled = false;
    expect(isAiChatActiveIn(CHAT_ID)).toBeFalse();
  });

  test("群开关缺省（从没设过）按关闭处理", () => {
    // 规范形状里开关的缺省值即关闭（见 packages/libs/chatState.ts 的 createChatState）。
    readiness.ok = true;
    chatState.isAIChatEnabled = createChatState().isAIChatEnabled;
    expect(isAiChatActiveIn(CHAT_ID)).toBeFalse();
  });
});
