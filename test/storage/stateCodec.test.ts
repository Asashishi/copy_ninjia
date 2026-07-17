import { describe, expect, test } from "bun:test";
import {
  copyModeValue,
  rebuildCachedUser,
  rebuildChatPermissions,
  rebuildChatState,
  rebuildLockdown,
} from "../../src/storage/stateCodec";

describe("storage/stateCodec", () => {
  test("ChatPermissions 只接收白名单内的 boolean 字段", () => {
    expect(rebuildChatPermissions({
      can_send_messages: true,
      can_invite_users: false,
      can_send_photos: "yes",
      injected: true,
    })).toEqual({
      can_send_messages: true,
      can_invite_users: false,
    });
  });

  test("空或完全无效的权限不能成为可恢复快照", () => {
    expect(rebuildChatPermissions({})).toBeNull();
    expect(rebuildChatPermissions({ can_send_messages: 1 })).toBeNull();
    expect(rebuildChatPermissions([])).toBeNull();
  });

  test("lockdown 只接受当前的完整结构，不接管裸权限旧结构", () => {
    expect(rebuildLockdown({ can_invite_users: true })).toBeUndefined();
  });

  test("lockdown 保留有效到期时间，字段无效时整条拒绝", () => {
    const now = 2_000_000;
    expect(rebuildLockdown({
      originalPermissions: { can_send_messages: true },
      expiresAt: now + 123,
    })?.expiresAt).toBe(now + 123);
    expect(rebuildLockdown({
      originalPermissions: { can_send_messages: true },
      expiresAt: "later",
    })).toBeUndefined();
  });

  test("CachedUser 与 ChatState 会丢弃未知或类型错误字段", () => {
    expect(rebuildCachedUser({ id: 42, username: "Ninja", first_name: 7, injected: true })).toEqual({
      id: 42,
      username: "Ninja",
      first_name: undefined,
      last_name: undefined,
      title: undefined,
      isChannel: undefined,
    });
    expect(rebuildCachedUser({ id: 1.5 })).toBeNull();

    expect(rebuildChatState({
      quietUntil: 123,
      isUseAIChat: true,
      isInit: "yes",
      lockdown: { originalPermissions: {} },
      injected: true,
    })).toEqual({
      quietUntil: 123,
      lockdown: undefined,
      isUseAIChat: true,
      isJATranslationEnabled: undefined,
      isInit: undefined,
      botIsAdmin: undefined,
    });
  });

  test("ChatState.title 只接收字符串，类型不对丢弃", () => {
    expect(rebuildChatState({ title: "测试群" })?.title).toBe("测试群");
    expect(rebuildChatState({ title: 123 })?.title).toBeUndefined();
    expect(rebuildChatState({})?.title).toBeUndefined();
  });

  test("ChatState.isUseProxySend 只接收 boolean，类型不对丢弃——供 /send 重启后按目标群自身状态恢复中转", () => {
    expect(rebuildChatState({ isUseProxySend: true })?.isUseProxySend).toBe(true);
    expect(rebuildChatState({ isUseProxySend: false })?.isUseProxySend).toBe(false);
    expect(rebuildChatState({ isUseProxySend: "yes" })?.isUseProxySend).toBeUndefined();
  });

  test("copy mode 只接受领域联合类型中的值", () => {
    expect(copyModeValue("reverse")).toBe("reverse");
    expect(copyModeValue("nya")).toBe("nya");
    expect(copyModeValue("ja")).toBe("ja");
    expect(copyModeValue("plain")).toBeUndefined();
    expect(copyModeValue(null)).toBeUndefined();
  });
});
