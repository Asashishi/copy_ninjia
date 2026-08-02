import { describe, expect, test } from "bun:test";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";

describe("decodeStateFile", () => {
  test("恢复完整的当前状态", () => {
    expect(decodeStateFile({
      chats: {
        "-1001": {
          isInitEnabled: true,
          lockdown: {
            phase: "active",
            intentId: 1,
            originalPermissions: { can_send_messages: true, can_invite_users: false },
            expiresAt: 2_000_000,
          },
        },
      },
      globalCopy: { copiedUser: null, lastCopyTime: 1_000_000 },
    })).toEqual({
      chats: {
        "-1001": {
          quietUntil: undefined,
          lockdown: {
            phase: "active",
            intentId: 1,
            originalPermissions: { can_send_messages: true, can_invite_users: false },
            expiresAt: 2_000_000,
          },
          isAIChatEnabled: undefined,
          isJATranslationEnabled: undefined,
          isAdDetectEnabled: undefined,
          isFloodControlEnabled: undefined,
          isInitEnabled: true,
          botIsAdmin: undefined,
          title: undefined,
          isProxySendEnabled: undefined,
        },
      },
      globalCopy: { copiedUser: null, lastCopyTime: 1_000_000 },
    });
  });

  test("存在但损坏的 lockdown 会拒绝整个文件", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { originalPermissions: {}, expiresAt: "later" },
        },
      },
      globalCopy: { copiedUser: null },
    })).toThrow("state.chats.-1001.lockdown");
  });

  test("lockdown 当前格式要求 phase 和正数 intentId", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { intentId: 1, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      globalCopy: { copiedUser: null },
    })).toThrow("state.chats.-1001.lockdown.phase is required");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      globalCopy: { copiedUser: null },
    })).toThrow("state.chats.-1001.lockdown.intentId must be a positive safe integer");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", intentId: 0, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      globalCopy: { copiedUser: null },
    })).toThrow("state.chats.-1001.lockdown.intentId must be a positive safe integer");
  });

  test("空 ChatPermissions 合法，但未知字段和非 boolean 仍拒绝", () => {
    expect(decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, originalPermissions: {}, expiresAt: 2_000 } } },
      globalCopy: { copiedUser: null },
    }).chats["-1001"]?.lockdown?.originalPermissions).toEqual({});
    expect(() => decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, originalPermissions: { can_fly: true }, expiresAt: 2_000 } } },
      globalCopy: { copiedUser: null },
    })).toThrow("can_fly");
    expect(() => decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, originalPermissions: { can_invite_users: "yes" }, expiresAt: 2_000 } } },
      globalCopy: { copiedUser: null },
    })).toThrow("can_invite_users");
  });

  test("未知字段、错误类型和失配的复读组合均拒绝", () => {
    expect(() => decodeStateFile({ chats: {}, globalCopy: { copiedUser: null }, version: 1 })).toThrow("state.version");
    expect(() => decodeStateFile({ chats: { nope: {} }, globalCopy: { copiedUser: null } })).toThrow("invalid chat id");
    expect(() => decodeStateFile({
      chats: {},
      globalCopy: { copiedUser: null, copyChatId: -1001 },
    })).toThrow("without copiedUser");
  });

  test("多个活动中转目标拒绝加载，不能静默选取第一个", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": { isProxySendEnabled: true },
        "-1002": { isProxySendEnabled: true },
      },
      globalCopy: { copiedUser: null },
    })).toThrow("multiple active proxy send targets: -1001, -1002");
  });

  test("防刷屏开关按当前字段严格解码，缺省保持关闭", () => {
    expect(decodeStateFile({
      chats: { "-1001": { isFloodControlEnabled: true } },
      globalCopy: { copiedUser: null },
    }).chats["-1001"]?.isFloodControlEnabled).toBe(true);
    expect(() => decodeStateFile({
      chats: { "-1001": { isFloodControlEnabled: "yes" } },
      globalCopy: { copiedUser: null },
    })).toThrow("state.chats.-1001.isFloodControlEnabled must be a boolean");
  });

  test("旧版功能开关字段拒绝加载，避免新旧命名混用", () => {
    for (const legacyField of ["isUseAIChat", "isInit", "isUseProxySend"]) {
      expect(() => decodeStateFile({
        chats: { "-1001": { [legacyField]: true } },
        globalCopy: { copiedUser: null },
      })).toThrow(`state.chats.-1001.${legacyField}`);
    }
  });
});
