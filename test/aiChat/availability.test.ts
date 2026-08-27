/**
 * AI 闲聊「此刻到底跑不跑」的唯一判定入口（packages/aiChat/availability.ts）。
 *
 * 这两个函数本身只有几行，但它们是一个合取：进程侧凭据/配置齐备 **且** 本群
 * `/ai_chat enable`。合取的任一半在调用点被漏掉，后果都写在该文件的头注里——
 * 漏在投喂路径上是每条群消息换一次「部署配置不可用」的错误日志，漏在 hydrate
 * 上会把「前提临时缺失」误读成「所有群都关了」，一次重启删光 memory/ 里的 AI
 * 记忆。因此这里逐组合钉住四个真值表格子，而不是只测「开着能用」。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatState } from "../../packages/types/chatState";

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
    // 这一格承重：hydrate 那条路把「本群没开」当成删记忆的依据，若这里把
    // 「凭据没配好」折算成「群关了」，一次重启就会删光 memory/ 里的 AI 记忆。
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
    // ChatState 的规范形状里这个字段恒存在、缺省为 undefined（见
    // libs/chatState.ts 的 createChatState）；判定必须是严格 === true。
    readiness.ok = true;
    chatState.isAIChatEnabled = undefined;
    expect(isAiChatActiveIn(CHAT_ID)).toBeFalse();
  });
});
