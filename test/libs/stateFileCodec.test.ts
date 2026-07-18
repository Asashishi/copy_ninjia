import { describe, expect, test } from "bun:test";
import { decodeStateFile } from "../../src/libs/stateFileCodec";

describe("decodeStateFile", () => {
  test("恢复完整的当前状态", () => {
    expect(decodeStateFile({
      chats: {
        "-1001": {
          isInit: true,
          lockdown: {
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
            originalPermissions: { can_send_messages: true, can_invite_users: false },
            expiresAt: 2_000_000,
          },
          isUseAIChat: undefined,
          isJATranslationEnabled: undefined,
          isInit: true,
          botIsAdmin: undefined,
          title: undefined,
          isUseProxySend: undefined,
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

  test("未知字段、错误类型和失配的复读组合均拒绝", () => {
    expect(() => decodeStateFile({ chats: {}, globalCopy: { copiedUser: null }, version: 1 })).toThrow("state.version");
    expect(() => decodeStateFile({ chats: { nope: {} }, globalCopy: { copiedUser: null } })).toThrow("invalid chat id");
    expect(() => decodeStateFile({
      chats: {},
      globalCopy: { copiedUser: null, copyChatId: -1001 },
    })).toThrow("without copiedUser");
  });
});
