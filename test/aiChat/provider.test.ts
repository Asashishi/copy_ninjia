/**
 * 供应商选取：两把凭据都在时仍默认走 Gemini。
 *
 * 按配置组合拆文件（同 featurePreflight / featurePreflightMissingKey 的分法）：
 * config 的值在模块 import 期就绑定，同一文件里改不动。
 * 降级与两把都缺的分支见 providerFallback / providerUnconfigured。
 */

import { beforeEach, expect, mock, test } from "bun:test";

mock.module("../../packages/infra/config", () => ({
  AI_CHAT_GEMINI_API_KEY: "test-gemini-key",
  AI_CHAT_OPENAI_API_KEY: "test-openai-key",
}));

const { activeAiProvider, chatAiProvider, imageAiProvider } = await import("../../packages/aiChat/provider");
const { hasAiChatCredentials } = await import("../../packages/aiChat/credentials");
const { imageProviderOverrideMirror } = await import("../../packages/cache/workers/aiChat/imageProvider");
const { chatProviderOverrideMirror } = await import("../../packages/cache/workers/aiChat/chatProvider");

beforeEach(() => {
  imageProviderOverrideMirror.current = null;
  chatProviderOverrideMirror.current = null;
});

test("两把都配齐时不做运行时切换，恒定走 Gemini", () => {
  expect(activeAiProvider().name).toBe("gemini");
  expect(activeAiProvider().name).toBe("gemini");
});

test("凭据判定为真", () => {
  expect(hasAiChatCredentials()).toBe(true);
});

test("没有覆盖时生图跟随默认选取", () => {
  // 空镜像的 fail-safe 含义是「从没设过」，不是「沿用上一次」。
  expect(imageAiProvider().name).toBe("gemini");
});

test("没有覆盖时闲聊侧跟随默认选取", () => {
  expect(chatAiProvider().name).toBe("gemini");
});

test("`/image_model` 的覆盖只改生图这一项，闲聊侧照旧走默认供应商", () => {
  imageProviderOverrideMirror.current = "openai";
  expect(imageAiProvider().name).toBe("openai");
  expect(chatAiProvider().name).toBe("gemini");
  expect(activeAiProvider().name).toBe("gemini");

  imageProviderOverrideMirror.current = "gemini";
  expect(imageAiProvider().name).toBe("gemini");
});

test("`/chat_model` 的覆盖只改闲聊侧三项，生图照旧走默认供应商", () => {
  chatProviderOverrideMirror.current = "openai";
  expect(chatAiProvider().name).toBe("openai");
  expect(imageAiProvider().name).toBe("gemini");
  expect(activeAiProvider().name).toBe("gemini");

  chatProviderOverrideMirror.current = "gemini";
  expect(chatAiProvider().name).toBe("gemini");
});

test("两条命令各切各的，可以指向不同的两家", () => {
  // 两份镜像是同构的独立单值，不是一份带两个字段的——互不牵连正是它们分开的理由。
  chatProviderOverrideMirror.current = "openai";
  imageProviderOverrideMirror.current = "gemini";
  expect(chatAiProvider().name).toBe("openai");
  expect(imageAiProvider().name).toBe("gemini");
});

test("四项能力已装配齐全", () => {
  const provider = activeAiProvider();
  expect(typeof provider.createReplySession).toBe("function");
  expect(typeof provider.generateText).toBe("function");
  expect(typeof provider.describeVision).toBe("function");
  expect(typeof provider.generateImage).toBe("function");
});
