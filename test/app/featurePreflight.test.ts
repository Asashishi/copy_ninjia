/**
 * 「已经开着的功能，前提必须齐备」的启动闸。
 *
 * 这条闸补的是「不再统一预热配置」留下的窟窿：谁都没开的功能缺前提只该关掉
 * 它自己，但 state.json 里那个 true 是管理员当初明确按下的——悄悄降级成静默
 * 不干活，群里看到的就是机器人从某次重启起再也不理人，而日志里只有一行没人
 * 在看的诊断。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConfigReadiness } from "../../packages/types/config";

const states = new Map<number, Record<string, unknown>>();
let aiChatVerdict: ConfigReadiness = { ok: true };
let adDetectVerdict: ConfigReadiness = { ok: true };
let jaTranslateVerdict: ConfigReadiness = { ok: true };

function broken(file: string): ConfigReadiness {
  return { ok: false, failure: { file, reason: `Invalid ${file}: boom` } };
}

// 两把 key 都配着；缺 key 那一侧在 featurePreflightMissingKey.test.ts——config
// 的 mock 是整文件生效的，「配了」与「没配」两种进程状态没法在同一文件里切换。
mock.module("../../packages/infra/config", () => ({
  AI_CHAT_GEMINI_API_KEY: "test-gemini-key",
  AD_DETECT_DEEPSEEK_API_KEY: "test-deepseek-key",
}));
mock.module("../../packages/config/readiness", () => ({
  aiChatConfigReadiness: (): ConfigReadiness => aiChatVerdict,
  adDetectConfigReadiness: (): ConfigReadiness => adDetectVerdict,
  jaTranslateConfigReadiness: (): ConfigReadiness => jaTranslateVerdict,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): Map<number, Record<string, unknown>> => states,
}));

const { preflightEnabledFeatures } = await import("../../packages/app/featurePreflight");

beforeEach(() => {
  states.clear();
  aiChatVerdict = { ok: true };
  adDetectVerdict = { ok: true };
  jaTranslateVerdict = { ok: true };
});

describe("已启用功能的启动前提核对", () => {
  test("没有群开着这个功能时，缺前提不拦启动", () => {
    aiChatVerdict = broken("config/stickers.json");
    adDetectVerdict = broken("config/ad_samples.json");
    jaTranslateVerdict = broken("g-auth.json");
    states.set(-1001, { isInitEnabled: true });
    // 显式的 false 与「从没开过」同权：那是管理员关掉的开关，不是遗留启用。
    states.set(-1002, { isAIChatEnabled: false, isAdDetectEnabled: false });

    expect(() => preflightEnabledFeatures()).not.toThrow();
  });

  test("开着 AI 闲聊却写坏部署配置：拒绝启动，报错点名群、缺失项与出路", () => {
    aiChatVerdict = broken("config/stickers.json");
    states.set(-1001, { isAIChatEnabled: true });

    expect(() => preflightEnabledFeatures()).toThrow(/AI chat is enabled in 1 chat\(s\) \(-1001\)/);
    expect(() => preflightEnabledFeatures()).toThrow(/config\/stickers\.json is unusable/);
    // 报错必须给出出路，否则运维只能对着一个起不来的进程猜。
    expect(() => preflightEnabledFeatures()).toThrow(/\/ai_chat disable/);
  });

  test("广告检测与日语翻译各自成闸，多个群一起点名", () => {
    adDetectVerdict = broken("config/ad_samples.json");
    states.set(-1001, { isAdDetectEnabled: true });
    states.set(-1002, { isAdDetectEnabled: true });
    expect(() => preflightEnabledFeatures()).toThrow(/Ad detection is enabled in 2 chat\(s\) \(-1001, -1002\)/);

    adDetectVerdict = { ok: true };
    states.clear();
    states.set(-1003, { isJATranslationEnabled: true });
    jaTranslateVerdict = broken("g-auth.json");
    expect(() => preflightEnabledFeatures()).toThrow(/Japanese translation is enabled in 1 chat\(s\) \(-1003\)/);
  });

  test("前提齐备时静默通过，不因为功能开着就报错", () => {
    states.set(-1001, {
      isAIChatEnabled: true,
      isAdDetectEnabled: true,
      isJATranslationEnabled: true,
    });

    expect(() => preflightEnabledFeatures()).not.toThrow();
  });
});
