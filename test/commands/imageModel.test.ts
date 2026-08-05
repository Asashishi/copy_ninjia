/**
 * `/image_model gpt|gemini`：仅超管可切换生图供应商，且只切生图。
 *
 * 重点守四条：非超管一律拒绝（这条不可经 /permission 授权出去）、两把 key 缺
 * 任一把都拒绝并点名是哪一把、`gpt` 在命令层就归一成内部的 `openai`、
 * 落盘先于回执且推送恰好一次。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiProviderName } from "../../packages/types/aiChat/provider";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const persistAuthoritativeState = mock(async (..._args: unknown[]): Promise<void> => {});
const publishImageProvider = mock((_provider: AiProviderName): void => {});
const persistOrder: string[] = [];

let geminiKey: boolean = true;
let openAiKey: boolean = true;
let override: AiProviderName | undefined = undefined;

mock.module("../../packages/infra/config", () => ({ SUPER_ADMIN_USER_ID: 100 }));
// 凭据判定收口在 aiChat/credentials.ts，命令不直接读两个 env（见该文件头注）。
mock.module("../../packages/aiChat/credentials", () => ({
  hasGeminiChatCredentials: (): boolean => geminiKey,
  hasOpenAiChatCredentials: (): boolean => openAiKey,
}));
mock.module("../../packages/config/whitelist", () => ({
  hasWhitelistPermission: (id: number): boolean => id === 100,
}));
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage: sendMessage }));
mock.module("../../packages/aiChat", () => ({
  publishImageProvider: (provider: AiProviderName): void => {
    persistOrder.push("publish");
    publishImageProvider(provider);
  },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getImageProviderOverride: (): AiProviderName | undefined => override,
  setImageProviderOverride: (provider: AiProviderName): void => { override = provider; },
  persistAuthoritativeState: async (context: string): Promise<void> => {
    persistOrder.push("persist");
    await persistAuthoritativeState(context);
  },
}));

const { handleImageModelCommand } = await import("../../packages/commands/imageModel");
const { IMAGE_MODEL_TEXTS } = await import("../../packages/consts/commands");

/** null 表示「连发起身份都认不出来」；显式传 undefined 会落回默认值。 */
function context(argument: string, userId: number | null = 100): never {
  return {
    chat: { id: -1001 },
    from: userId === null ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 7,
    match: argument,
  } as never;
}

/** 读取当前覆盖值；绕开 TS 对模块级 let 的字面量窄化。 */
function currentOverride(): AiProviderName | undefined {
  return override;
}

/** 最后一次回执的正文。 */
function lastText(): string {
  return (sendMessage.mock.calls.at(-1)![0] as { text: string }).text;
}

beforeEach(() => {
  sendMessage.mockClear();
  persistAuthoritativeState.mockClear();
  publishImageProvider.mockClear();
  persistOrder.length = 0;
  geminiKey = true;
  openAiKey = true;
  override = undefined;
});

describe("权限与参数", () => {
  test("非超级管理员一律拒绝，且不落盘不推送", async () => {
    await handleImageModelCommand(context("gpt", 101));

    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.rejection("@admin"));
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(publishImageProvider).not.toHaveBeenCalled();
  });

  test("认不出发起身份时同样拒绝", async () => {
    await handleImageModelCommand(context("gpt", null));
    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.rejection("哪个杂鱼"));
  });

  test("参数不是 gpt/gemini 时给用法提示", async () => {
    for (const argument of ["", "  ", "openai-4", "GPT5", "enable"]) {
      sendMessage.mockClear();
      await handleImageModelCommand(context(argument));
      expect(lastText()).toBe(IMAGE_MODEL_TEXTS.usage);
    }
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
  });

  test("参数大小写不敏感并去空白", async () => {
    await handleImageModelCommand(context("  GPT  "));
    expect(currentOverride()).toBe("openai");
  });
});

describe("两把 key 都在才允许切换", () => {
  test("缺 Gemini 那把时点名 Gemini", async () => {
    geminiKey = false;
    await handleImageModelCommand(context("gpt"));

    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.missingGeminiKey);
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(currentOverride()).toBeUndefined();
  });

  test("缺 OpenAI 那把时点名 OpenAI", async () => {
    openAiKey = false;
    await handleImageModelCommand(context("gemini"));

    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.missingOpenAiKey);
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(currentOverride()).toBeUndefined();
  });
});

describe("切换", () => {
  test("gpt 在命令层归一成内部的 openai，落盘先于推送、各一次", async () => {
    await handleImageModelCommand(context("gpt"));

    expect(currentOverride()).toBe("openai");
    expect(persistAuthoritativeState).toHaveBeenCalledTimes(1);
    expect(persistAuthoritativeState.mock.calls[0]![0]).toBe("image_model switched");
    expect(publishImageProvider).toHaveBeenCalledTimes(1);
    expect(publishImageProvider).toHaveBeenCalledWith("openai");
    // 权威决策必须先过 durability barrier 再让 Worker 看见，口径同 /ai_chat。
    expect(persistOrder).toEqual(["persist", "publish"]);
    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.switched("gpt"));
  });

  test("gemini 两侧同名，同样走别名表", async () => {
    override = "openai";
    await handleImageModelCommand(context("gemini"));

    expect(currentOverride()).toBe("gemini");
    expect(publishImageProvider).toHaveBeenCalledWith("gemini");
    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.switched("gemini"));
  });

  test("同值重复执行照常落盘并推送，但回执如实说没改变什么", async () => {
    override = "openai";
    await handleImageModelCommand(context("gpt"));

    // 重复执行仍落盘/推送：那是上一次推送失败后最自然的手工重试路径。
    expect(persistAuthoritativeState).toHaveBeenCalledTimes(1);
    expect(publishImageProvider).toHaveBeenCalledTimes(1);
    expect(lastText()).toBe(IMAGE_MODEL_TEXTS.unchanged("gpt"));
  });
});
