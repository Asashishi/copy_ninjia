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
      global: { copy: { copiedUser: null, lastCopyTime: 1_000_000 }, model: {} },
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
      global: { copy: { copiedUser: null, lastCopyTime: 1_000_000 }, model: {} },
    });
  });

  test("存在但损坏的 lockdown 会拒绝整个文件", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { originalPermissions: {}, expiresAt: "later" },
        },
      },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("state.chats.-1001.lockdown");
  });

  test("lockdown 当前格式要求 phase 和正数 intentId", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { intentId: 1, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("state.chats.-1001.lockdown.phase is required");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("state.chats.-1001.lockdown.intentId must be a positive safe integer");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", intentId: 0, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("state.chats.-1001.lockdown.intentId must be a positive safe integer");
  });

  test("空 ChatPermissions 合法，但未知字段和非 boolean 仍拒绝", () => {
    expect(decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, originalPermissions: {}, expiresAt: 2_000 } } },
      global: { copy: { copiedUser: null }, model: {} },
    }).chats["-1001"]?.lockdown?.originalPermissions).toEqual({});
    expect(() => decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, originalPermissions: { can_fly: true }, expiresAt: 2_000 } } },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("can_fly");
    expect(() => decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, originalPermissions: { can_invite_users: "yes" }, expiresAt: 2_000 } } },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("can_invite_users");
  });

  test("未知字段、错误类型和失配的复读组合均拒绝", () => {
    expect(() => decodeStateFile({ chats: {}, global: { copy: { copiedUser: null }, model: {} }, version: 1 })).toThrow("state.version");
    expect(() => decodeStateFile({ chats: { nope: {} }, global: { copy: { copiedUser: null }, model: {} } })).toThrow("invalid chat id");
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null, copyChatId: -1001 }, model: {} },
    })).toThrow("without copiedUser");
  });

  test("多个活动中转目标拒绝加载，不能静默选取第一个", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": { isProxySendEnabled: true },
        "-1002": { isProxySendEnabled: true },
      },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("multiple active proxy send targets: -1001, -1002");
  });

  test("防刷屏开关按当前字段严格解码，缺省保持关闭", () => {
    expect(decodeStateFile({
      chats: { "-1001": { isFloodControlEnabled: true } },
      global: { copy: { copiedUser: null }, model: {} },
    }).chats["-1001"]?.isFloodControlEnabled).toBe(true);
    expect(() => decodeStateFile({
      chats: { "-1001": { isFloodControlEnabled: "yes" } },
      global: { copy: { copiedUser: null }, model: {} },
    })).toThrow("state.chats.-1001.isFloodControlEnabled must be a boolean");
  });

  test("模型块整块缺省 = 两项都没设过：手工迁移只写 copy 也能读回", () => {
    const decoded = decodeStateFile({ chats: {}, global: { copy: { copiedUser: null } } });
    expect(decoded.global.model).toEqual({ image: undefined, chat: undefined });
  });

  test("两项模型选取的合法值原样读回，且各自独立", () => {
    for (const provider of ["gemini", "openai"] as const) {
      const decoded = decodeStateFile({
        chats: {},
        global: { copy: { copiedUser: null }, model: { image: provider, chat: provider } },
      });
      expect(decoded.global.model.image).toBe(provider);
      expect(decoded.global.model.chat).toBe(provider);
    }
    const mixed = decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, model: { image: "gemini", chat: "openai" } },
    });
    expect(mixed.global.model.image).toBe("gemini");
    expect(mixed.global.model.chat).toBe("openai");
  });

  test("模型选取写坏时拒绝整份状态，不静默丢掉这一项", () => {
    // 静默丢掉等于让超管以为切过了、实际还在用默认供应商。
    for (const bad of ["gpt", "GEMINI", "", 1, null]) {
      expect(() => decodeStateFile({
        chats: {},
        global: { copy: { copiedUser: null }, model: { image: bad } },
      })).toThrow("state.global.model.image must be one of gemini or openai");
      expect(() => decodeStateFile({
        chats: {},
        global: { copy: { copiedUser: null }, model: { chat: bad } },
      })).toThrow("state.global.model.chat must be one of gemini or openai");
    }
  });

  test("global 块的未知键与缺失 copy 都拒绝整份状态", () => {
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, model: {}, mood: "happy" },
    })).toThrow("state.global.mood is not part of the current state schema");
    expect(() => decodeStateFile({ chats: {}, global: { model: {} } })).toThrow("state.global.copy is required");
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, model: { image: "gemini", nope: 1 } },
    })).toThrow("state.global.model.nope is not part of the current state schema");
  });

  test("旧结构（顶层 globalCopy / imageProvider / chatProvider）当场拒绝，不静默读成空", () => {
    // 结构变更只做手工迁移：兼容分支会让复读状态被静默读成空，而群里看不出区别。
    expect(() => decodeStateFile({
      chats: {},
      globalCopy: { copiedUser: null, lastCopyTime: 1_000_000 },
    })).toThrow("state.globalCopy is not part of the current state schema");
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, model: {} },
      imageProvider: "gemini",
    })).toThrow("state.imageProvider is not part of the current state schema");
    expect(() => decodeStateFile({ chats: {} })).toThrow("state.global is required");
  });

  test("旧版功能开关字段拒绝加载，避免新旧命名混用", () => {
    for (const legacyField of ["isUseAIChat", "isInit", "isUseProxySend"]) {
      expect(() => decodeStateFile({
        chats: { "-1001": { [legacyField]: true } },
        global: { copy: { copiedUser: null }, model: {} },
      })).toThrow(`state.chats.-1001.${legacyField}`);
    }
  });
});
