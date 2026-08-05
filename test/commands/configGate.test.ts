/**
 * 部署配置写坏时开关命令与 /switch_mood 的统一拒绝。这些文件不再在启动时预热
 * （见 config/readiness.ts），判定挪到了这里——覆盖不上就等于把「一份坏文件
 * 关掉整个进程」换成了「一个看着已生效、实际什么都不做的开关」。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConfigReadiness } from "../../packages/types/config";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const persistAuthoritativeState = mock(async (..._args: unknown[]): Promise<void> => {});
const loggerError = mock((..._args: unknown[]): void => {});
const clearAdDetection = mock((..._args: unknown[]): void => {});
const handleCopyCommand = mock(async (..._args: unknown[]): Promise<void> => {});
const queryAiMood = mock(async (_chatId: number): Promise<string> => "平静");
const switchAiMood = mock(async (_chatId: number): Promise<string> => "开心");
const states = new Map<number, Record<string, unknown>>();

function broken(file: string): ConfigReadiness {
  return { ok: false, failure: { file, reason: `Invalid ${file}: boom` } };
}

let aiChatVerdict: ConfigReadiness = { ok: true };
let adDetectVerdict: ConfigReadiness = { ok: true };
let jaTranslateVerdict: ConfigReadiness = { ok: true };

mock.module("../../packages/config/readiness", () => ({
  aiChatConfigReadiness: (): ConfigReadiness => aiChatVerdict,
  adDetectConfigReadiness: (): ConfigReadiness => adDetectVerdict,
  jaTranslateConfigReadiness: (): ConfigReadiness => jaTranslateVerdict,
}));
// 两把可选 key 都配着：这个文件只考配置那一半，凭据那一半在
// optionalApiKeys.test.ts。
mock.module("../../packages/infra/config", () => ({
  SUPER_ADMIN_USER_ID: 100,
  AI_CHAT_GEMINI_API_KEY: "test-gemini-key",
  AI_CHAT_OPENAI_API_KEY: undefined,
  AD_DETECT_DEEPSEEK_API_KEY: "test-deepseek-key",
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/infra/logger", () => ({ logger: { error: loggerError } }));
mock.module("../../packages/aiChat", () => ({ invalidateAiChat: mock((): void => {}), queryAiMood, switchAiMood }));
mock.module("../../packages/antiRaid", () => ({ clearAdDetection }));
mock.module("../../packages/commands/copy", () => ({ handleCopyCommand }));
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

const { handleAiChatCommand } = await import("../../packages/commands/aiChat");
const { handleAdDetectCommand } = await import("../../packages/commands/adDetect");
const { handleJaCopyCommand } = await import("../../packages/commands/jaCopy");
const { handleQueryMoodCommand, handleSwitchMoodCommand } = await import("../../packages/commands/mood");

function context(argument: string): never {
  return {
    chat: { id: -1001 },
    from: { id: 100, first_name: "Admin", username: "admin" },
    msgId: 7,
    match: argument,
  } as never;
}

beforeEach(() => {
  states.clear();
  sendMessage.mockClear();
  persistAuthoritativeState.mockClear();
  loggerError.mockClear();
  clearAdDetection.mockClear();
  handleCopyCommand.mockClear();
  queryAiMood.mockClear();
  switchAiMood.mockClear();
  aiChatVerdict = { ok: true };
  adDetectVerdict = { ok: true };
  jaTranslateVerdict = { ok: true };
});

describe("部署配置写坏时的 enable 拒绝", () => {
  test("/ai_chat enable 点名坏掉的那份文件，状态一个字都不改", async () => {
    aiChatVerdict = broken("config/mood.json");
    await handleAiChatCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/mood.json"),
      replyToMessageId: 7,
    });
    // 用户看到的是中文文案，运维要的定位信息在日志里（英文，见 AGENTS.md）。
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("Invalid config/mood.json"));
  });

  test("/ai_chat disable 不受配置影响：坏掉之后仍要能清残留开关", async () => {
    aiChatVerdict = broken("config/mood.json");
    states.set(-1001, { isAIChatEnabled: true });
    await handleAiChatCommand(context("disable"));

    expect(states.get(-1001)?.isAIChatEnabled).toBe(false);
    expect(persistAuthoritativeState).toHaveBeenCalledWith("ai_chat toggled");
  });

  test("/ad_detect enable 点名示例清单", async () => {
    adDetectVerdict = broken("config/ad_samples.json");
    await handleAdDetectCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/ad_samples.json"),
      replyToMessageId: 7,
    });
  });

  test("/ja_copy enable 点名服务账号密钥", async () => {
    jaTranslateVerdict = broken("g-auth.json");
    await handleJaCopyCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("g-auth.json"),
      replyToMessageId: 7,
    });
  });

  test("/switch_mood 也点名坏掉的心情表，不投递重抽请求", async () => {
    // 本群开着 AI 闲聊（配置是后来才被改坏的）：拒绝理由必须是那份文件，
    // 而不是「Worker 没回话」那条兜底文案。
    aiChatVerdict = broken("config/mood.json");
    states.set(-1001, { isAIChatEnabled: true });
    await handleSwitchMoodCommand(context(""));

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/mood.json"),
      replyToMessageId: 7,
    });
  });

  test("/query_mood 也点名坏掉的心情表，不投递查询请求", async () => {
    aiChatVerdict = broken("config/mood.json");
    states.set(-1001, { isAIChatEnabled: true });
    await handleQueryMoodCommand(context(""));

    expect(queryAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/mood.json"),
      replyToMessageId: 7,
    });
  });

  test("/ja_copy 不带参数仍是普通复读命令，不碰这道判定", async () => {
    jaTranslateVerdict = broken("g-auth.json");
    await handleJaCopyCommand(context(""));

    expect(handleCopyCommand).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("配置都读得动时三个开关照常写状态", async () => {
    await handleAiChatCommand(context("enable"));
    await handleAdDetectCommand(context("enable"));
    await handleJaCopyCommand(context("enable"));

    expect(states.get(-1001)).toEqual({
      isAIChatEnabled: true,
      isAdDetectEnabled: true,
      isJATranslationEnabled: true,
    });
    expect(loggerError).not.toHaveBeenCalled();
  });
});
