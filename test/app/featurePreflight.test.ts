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
let deploymentInputFailure: Error | null = null;

function broken(file: string): ConfigReadiness {
  return { ok: false, failure: { file, reason: `${file}: $ must match its current schema.` } };
}

mock.module("../../packages/config/readiness", () => ({
  aiChatConfigReadiness: (): ConfigReadiness => aiChatVerdict,
  adDetectConfigReadiness: (): ConfigReadiness => adDetectVerdict,
  jaTranslateConfigReadiness: (): ConfigReadiness => jaTranslateVerdict,
  validateExistingDeploymentInputs: (): void => {
    if (deploymentInputFailure !== null) throw deploymentInputFailure;
  },
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
  deploymentInputFailure = null;
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

  test("开着 AI 闲聊却缺少前提：拒绝启动且只输出安全配置定位", () => {
    aiChatVerdict = broken("config/stickers.json");
    states.set(-1001, { isAIChatEnabled: true });

    expect(() => preflightEnabledFeatures()).toThrow("config/stickers.json: $ must match its current schema");
    expect(() => preflightEnabledFeatures()).not.toThrow(/-1001/);
  });

  test("广告检测与日语翻译各自成闸，多个群一起点名", () => {
    adDetectVerdict = broken("config/ad_samples.json");
    states.set(-1001, { isAdDetectEnabled: true });
    states.set(-1002, { isAdDetectEnabled: true });
    expect(() => preflightEnabledFeatures()).toThrow("config/ad_samples.json: $ must match its current schema");

    adDetectVerdict = { ok: true };
    states.clear();
    states.set(-1003, { isJATranslationEnabled: true });
    jaTranslateVerdict = broken("g-auth.json");
    expect(() => preflightEnabledFeatures()).toThrow("g-auth.json: $ must match its current schema");
  });

  test("已经存在的坏配置在功能关闭时也拒绝启动", () => {
    states.set(-1001, { isAIChatEnabled: false });
    deploymentInputFailure = new Error("config/stickers.json: $.packs must be an array.");

    expect(() => preflightEnabledFeatures()).toThrow("config/stickers.json: $.packs must be an array");
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
