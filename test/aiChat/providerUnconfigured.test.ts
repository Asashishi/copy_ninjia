/**
 * 供应商选取：两把凭据都缺时抛错、凭据判定为假。与 provider.test.ts 分文件的
 * 理由见那边的模块头注。
 *
 * 抛错而不是返回 null：走到 activeAiProvider 说明 availability 那道门禁已经
 * 放行过一次（配置在进程启动后被抽掉），调用方各自的降级路径会把它归一成一次
 * 普通失败，不该让一次凭据缺失把整个 Worker 掀掉。
 */

import { expect, mock, test } from "bun:test";

mock.module("../../packages/infra/config", () => ({
  AI_CHAT_GEMINI_API_KEY: undefined,
  AI_CHAT_OPENAI_API_KEY: undefined,
}));

const { activeAiProvider } = await import("../../packages/aiChat/provider");
const { hasAiChatCredentials } = await import("../../packages/aiChat/credentials");

test("两把都缺时抛错并点名两个变量", () => {
  expect(() => activeAiProvider()).toThrow(/AI_CHAT_GEMINI_API_KEY or AI_CHAT_OPENAI_API_KEY/);
});

test("凭据判定为假", () => {
  expect(hasAiChatCredentials()).toBe(false);
});
