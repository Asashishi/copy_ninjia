/**
 * 两把可选 AI 凭据（AI_CHAT_GEMINI_API_KEY / AD_DETECT_DEEPSEEK_API_KEY）都没配
 * 时的命令行为。单独一个文件而不是并进 toggleCommands.test.ts：config 的 mock
 * 是整文件生效的，「配了」与「没配」两种进程状态没法在同一个文件里切换。
 *
 * 关掉方向刻意不拦：凭据被从 .env 里撤掉之后，运维仍要能把残留的开关和这个群
 * 的 AI 记忆清干净。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const invalidateAiChat = mock((..._args: unknown[]): void => {});
const queryAiMood = mock(async (_chatId: number): Promise<string> => "平静");
const switchAiMood = mock(async (_chatId: number): Promise<string> => "开心");
const clearAdDetection = mock((..._args: unknown[]): void => {});
const persistAuthoritativeState = mock(async (..._args: unknown[]): Promise<void> => {});
const loggerError = mock((..._args: unknown[]): void => {});
const states = new Map<number, Record<string, unknown>>();

// 两把可选 key 都缺席：mock 里根本不导出它们，等价于 .env 留空。
mock.module("../../packages/infra/config", () => ({
  SUPER_ADMIN_USER_ID: 100,
  AI_CHAT_GEMINI_API_KEY: undefined,
  AD_DETECT_DEEPSEEK_API_KEY: undefined,
}));
// 超级管理员由身份直接持有全部白名单权限（见 packages/config/whitelist.ts）。
mock.module("../../packages/config/whitelist", () => ({
  hasWhitelistPermission: (id: number): boolean => id === 100,
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/aiChat", () => ({ invalidateAiChat, queryAiMood, switchAiMood }));
mock.module("../../packages/antiRaid", () => ({ clearAdDetection }));
mock.module("../../packages/infra/logger", () => ({ logger: { error: loggerError } }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getOrCreateChatState(chatId: number): Record<string, unknown> {
    let state = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  persistAuthoritativeState,
}));

const { handleAdDetectCommand } = await import("../../packages/commands/adDetect");
const { handleAiChatCommand } = await import("../../packages/commands/aiChat");
const { handleQueryMoodCommand, handleSwitchMoodCommand } = await import("../../packages/commands/mood");

function context(argument: string, userId: number = 100): never {
  return {
    chat: { id: -1001 },
    from: { id: userId, first_name: "Admin", username: "admin" },
    msgId: 7,
    match: argument,
  } as never;
}

beforeEach(() => {
  states.clear();
  sendMessage.mockClear();
  invalidateAiChat.mockClear();
  queryAiMood.mockClear();
  switchAiMood.mockClear();
  clearAdDetection.mockClear();
  persistAuthoritativeState.mockClear();
  loggerError.mockClear();
});

describe("可选 AI 凭据缺席时的命令降级", () => {
  test("/ai_chat enable 被拒且不写状态，点名缺的是哪个变量", async () => {
    await handleAiChatCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("AI_CHAT_GEMINI_API_KEY"),
      replyToMessageId: 7,
    });
  });

  test("/ai_chat disable 照常执行：凭据被撤掉之后仍要能清残留开关与记忆", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleAiChatCommand(context("disable"));

    expect(states.get(-1001)?.isAIChatEnabled).toBe(false);
    expect(persistAuthoritativeState).toHaveBeenCalledWith("ai_chat toggled");
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);
  });

  test("/switch_mood 在读群开关之前就被拒，不投递重抽请求", async () => {
    // 群里开关还开着（凭据是后来才被撤掉的）：拒绝理由仍必须是缺 key，
    // 而不是「本群没开 AI 闲聊」那条会把人带偏的文案。
    states.set(-1001, { isAIChatEnabled: true });
    await handleSwitchMoodCommand(context(""));

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("AI_CHAT_GEMINI_API_KEY"),
      replyToMessageId: 7,
    });
  });

  test("/query_mood 在读群开关之前就被拒，不投递查询请求", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleQueryMoodCommand(context("", 101));

    expect(queryAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("AI_CHAT_GEMINI_API_KEY"),
      replyToMessageId: 7,
    });
  });

  test("/ad_detect enable 被拒且不写状态", async () => {
    await handleAdDetectCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("AD_DETECT_DEEPSEEK_API_KEY"),
      replyToMessageId: 7,
    });
  });

  test("/ad_detect disable 照常执行并清掉 Worker 待检队列", async () => {
    states.set(-1001, { isAdDetectEnabled: true });
    await handleAdDetectCommand(context("disable"));

    expect(states.get(-1001)?.isAdDetectEnabled).toBe(false);
    expect(clearAdDetection).toHaveBeenCalledWith(-1001);
  });
});
