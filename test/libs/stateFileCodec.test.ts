import { describe, expect, test } from "bun:test";
import { decodeGlobalStateFile } from "../../packages/libs/stateFileCodec";
import type { DecodedGlobalState } from "../../packages/types/chatState";

/** 以固定来源路径解码全局状态文档。 */
function decode(value: unknown): DecodedGlobalState {
  return decodeGlobalStateFile(value, "state.json");
}

describe("decodeGlobalStateFile", () => {
  test("恢复完整的全局状态", () => {
    expect(decode({ copy: { copiedUser: null, lastCopyTime: 1_000_000 } })).toEqual({
      copy: { copiedUser: null, lastCopyTime: 1_000_000 },
      ttsUsage: undefined,
    });
  });

  test("语音合成每日计数：缺省为从没用过，存在时两项都必须合法", () => {
    expect(decode({ copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1_000, count: 100 } }).ttsUsage)
      .toEqual({ windowStartedAt: 1_000, count: 100 });
    expect(decode({ copy: { copiedUser: null } }).ttsUsage).toBeUndefined();
    expect(() => decode({ copy: { copiedUser: null }, ttsUsage: { count: 1 } }))
      .toThrow("state.json: $.ttsUsage.windowStartedAt must be a non-negative safe integer timestamp.");
    // count 不与 agent.tts.daily_limit 对拍：上限调低后已用次数可以超过新上限。
    expect(decode({ copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1, count: 1_000 } }).ttsUsage)
      .toEqual({ windowStartedAt: 1, count: 1_000 });
    for (const count of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode({ copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1, count } }))
        .toThrow("state.json: $.ttsUsage.count must be a positive safe integer.");
    }
    expect(() => decode({ copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1, count: 1, day: 1 } }))
      .toThrow("state.json: $.ttsUsage.day must be absent (not part of the current state schema).");
    expect(() => decode({ copy: { copiedUser: null }, ttsUsage: null }))
      .toThrow("state.json: $.ttsUsage must be an object.");
  });

  test("未知字段和失配的复读组合均拒绝", () => {
    expect(() => decode({ copy: { copiedUser: null }, version: 1 }))
      .toThrow("state.json: $.version must be absent (not part of the current state schema).");
    expect(() => decode({ copy: { copiedUser: null, copyChatId: -1001 } }))
      .toThrow("free of copyMode and copyChatId when copiedUser is null");
  });

  test("复读状态的 copyChatId 只接受 Telegram 群或频道负 ID", () => {
    expect(() => decode({ copy: { copiedUser: { id: 42, first_name: "目标" }, copyChatId: 1001 } }))
      .toThrow("state.json: $.copy.copyChatId must be a negative safe integer");
    expect(() => decode({ copy: { copiedUser: { id: 42, first_name: "目标" }, copyChatId: -1001 } })).not.toThrow();
  });

  test("14.x 的 global 包装、assets、translate 与 model 都不属于当前 schema", () => {
    // 结构变更只做冷迁移：兼容分支会让复读状态被静默读成空，而群里看不出区别。
    expect(() => decode({ global: { copy: { copiedUser: null } } }))
      .toThrow("state.json: $.global must be absent (not part of the current state schema).");
    for (const key of ["assets", "translate", "model", "chats"]) {
      expect(() => decode({ copy: { copiedUser: null }, [key]: {} }))
        .toThrow(`state.json: $.${key} must be absent (not part of the current state schema).`);
    }
  });

  test("顶层必须是对象且 copy 必填", () => {
    expect(() => decode({})).toThrow("state.json: $.copy must be present.");
    for (const value of [null, [], "x"]) {
      expect(() => decode(value)).toThrow("state.json: $ must be an object.");
    }
  });
});
