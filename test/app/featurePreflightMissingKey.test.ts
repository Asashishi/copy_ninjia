/**
 * 「开着功能却把 key 从 .env 里抽掉」这条路径的启动闸。与
 * featurePreflight.test.ts 是同一道闸的另一种进程状态，因此必须另开一个文件：
 * config 的 mock 整文件生效，「配了 key」与「没配 key」切不了。
 *
 * 这是最容易踩的一种：改 .env 比改 state.json 顺手得多，而少了这道闸，
 * 机器人会带着一个看着已生效、实际什么都不做的开关一路跑下去。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConfigReadiness } from "../../packages/types/config";

const states = new Map<number, Record<string, unknown>>();

// 两把可选 key 都缺席，部署配置本身完好：只考凭据那一半。
mock.module("../../packages/infra/config", () => ({
  AI_CHAT_GEMINI_API_KEY: undefined,
  AI_CHAT_OPENAI_API_KEY: undefined,
  AD_DETECT_DEEPSEEK_API_KEY: undefined,
}));
mock.module("../../packages/config/readiness", () => ({
  aiChatConfigReadiness: (): ConfigReadiness => ({ ok: true }),
  adDetectConfigReadiness: (): ConfigReadiness => ({ ok: true }),
  jaTranslateConfigReadiness: (): ConfigReadiness => ({ ok: true }),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): Map<number, Record<string, unknown>> => states,
  // 本组只验凭据缺席那一侧，两项模型选取一律「从没设过」。
  getImageProviderOverride: (): undefined => undefined,
  getChatProviderOverride: (): undefined => undefined,
}));

const { preflightEnabledFeatures } = await import("../../packages/app/featurePreflight");

beforeEach(() => {
  states.clear();
});

describe("已启用功能遇上被抽掉的 key", () => {
  test("没有群开着时照常启动：谁都没开的功能缺 key 不该拦住整个进程", () => {
    states.set(-1001, { isInitEnabled: true, isJATranslationEnabled: true });

    expect(() => preflightEnabledFeatures()).not.toThrow();
  });

  test("开着 AI 闲聊：拒绝启动，点名群、变量名与出路", () => {
    states.set(-1001, { isAIChatEnabled: true });

    expect(() => preflightEnabledFeatures()).toThrow(/AI chat is enabled in 1 chat\(s\) \(-1001\)/);
    expect(() => preflightEnabledFeatures()).toThrow(/neither AI_CHAT_GEMINI_API_KEY nor AI_CHAT_OPENAI_API_KEY is set/);
    expect(() => preflightEnabledFeatures()).toThrow(/\/ai_chat disable/);
  });

  test("开着广告检测：同样拒绝启动", () => {
    states.set(-1002, { isAdDetectEnabled: true });

    expect(() => preflightEnabledFeatures()).toThrow(/AD_DETECT_DEEPSEEK_API_KEY is not set/);
    expect(() => preflightEnabledFeatures()).toThrow(/\/ad_detect disable/);
  });
});
