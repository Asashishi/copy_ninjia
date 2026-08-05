/**
 * 供应商选取：缺 Gemini 凭据时降级到 OpenAI。与 provider.test.ts 分文件的
 * 理由见那边的模块头注。
 */

import { expect, mock, test } from "bun:test";

mock.module("../../packages/infra/config", () => ({
  AI_CHAT_GEMINI_API_KEY: undefined,
  AI_CHAT_OPENAI_API_KEY: "test-openai-key",
}));

const { activeAiProvider, chatAiProvider, imageAiProvider } = await import("../../packages/aiChat/provider");
const { hasAiChatCredentials } = await import("../../packages/aiChat/credentials");
const { imageProviderOverrideMirror } = await import("../../packages/cache/workers/aiChat/imageProvider");
const { chatProviderOverrideMirror } = await import("../../packages/cache/workers/aiChat/chatProvider");

test("缺 Gemini 凭据时选中 OpenAI", () => {
  expect(activeAiProvider().name).toBe("openai");
});

test("只配 OpenAI 一把也算 AI 闲聊已配置", () => {
  expect(hasAiChatCredentials()).toBe(true);
});

test("选定值指向已被抽走 key 的那一家时抛错，不静默换家", () => {
  // 正常部署走不到：app/featurePreflight.ts 的启动闸已经拒绝了这种进程。真走到
  // 说明状态在运行期被外部改写，那时必须点名缺哪把 key，而不是让同一个群的
  // 回复口径无预警漂移。
  imageProviderOverrideMirror.current = "gemini";
  expect(() => imageAiProvider()).toThrow("AI_CHAT_GEMINI_API_KEY is not set");
  imageProviderOverrideMirror.current = null;
});

test("闲聊侧选定值指向已被抽走 key 的那一家时同样抛错", () => {
  chatProviderOverrideMirror.current = "gemini";
  expect(() => chatAiProvider()).toThrow("AI_CHAT_GEMINI_API_KEY is not set");
  chatProviderOverrideMirror.current = null;
});

test("没选过的那一项照旧跟随默认选取，不受上面那条影响", () => {
  imageProviderOverrideMirror.current = null;
  chatProviderOverrideMirror.current = null;
  expect(imageAiProvider().name).toBe("openai");
  expect(chatAiProvider().name).toBe("openai");
});

test("降级实现同样装配齐四项能力", () => {
  const provider = activeAiProvider();
  expect(typeof provider.createReplySession).toBe("function");
  expect(typeof provider.generateText).toBe("function");
  expect(typeof provider.describeVision).toBe("function");
  expect(typeof provider.generateImage).toBe("function");
});
