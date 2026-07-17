import { describe, expect, test } from "bun:test";
import { LOCKDOWN_MS } from "../../src/consts/antiRaid";
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

  test("旧版裸权限迁移为带满额到期时间的 LockdownRecord", () => {
    const now = 1_000_000;
    expect(rebuildLockdown({ can_invite_users: true }, now)).toEqual({
      originalPermissions: { can_invite_users: true },
      expiresAt: now + LOCKDOWN_MS,
    });
  });

  test("新版 lockdown 保留有效到期时间，非法时间回退为满额", () => {
    const now = 2_000_000;
    expect(rebuildLockdown({
      originalPermissions: { can_send_messages: true },
      expiresAt: now + 123,
    }, now)?.expiresAt).toBe(now + 123);
    expect(rebuildLockdown({
      originalPermissions: { can_send_messages: true },
      expiresAt: "later",
    }, now)?.expiresAt).toBe(now + LOCKDOWN_MS);
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
    }, 0)).toEqual({
      quietUntil: 123,
      lockdown: undefined,
      isUseAIChat: true,
      isJATranslationEnabled: undefined,
      isInit: undefined,
      botIsAdmin: undefined,
    });
  });

  test("ChatState.title 只接收字符串，类型不对丢弃", () => {
    expect(rebuildChatState({ title: "测试群" }, 0)?.title).toBe("测试群");
    expect(rebuildChatState({ title: 123 }, 0)?.title).toBeUndefined();
    expect(rebuildChatState({}, 0)?.title).toBeUndefined();
  });

  test("ChatState.isUseProxySend/proxySendTargetChatId 类型不对丢弃，供 /send 重启后恢复中转", () => {
    expect(rebuildChatState({ isUseProxySend: true, proxySendTargetChatId: -100123 }, 0)).toMatchObject({
      isUseProxySend: true,
      proxySendTargetChatId: -100123,
    });
    expect(rebuildChatState({ isUseProxySend: "yes", proxySendTargetChatId: "not-a-number" }, 0)).toMatchObject({
      isUseProxySend: undefined,
      proxySendTargetChatId: undefined,
    });
  });

  test("isUseProxySend 为 true 但目标 chatId 缺失/非法时整体判无效，不能半开着恢复", () => {
    expect(rebuildChatState({ isUseProxySend: true }, 0)).toMatchObject({
      isUseProxySend: undefined,
      proxySendTargetChatId: undefined,
    });
    expect(rebuildChatState({ isUseProxySend: true, proxySendTargetChatId: "bad" }, 0)).toMatchObject({
      isUseProxySend: undefined,
      proxySendTargetChatId: undefined,
    });
    // isUseProxySend 明确为 false 时，即便目标字段还留着旧值也不该带出来。
    expect(rebuildChatState({ isUseProxySend: false, proxySendTargetChatId: -100123 }, 0)).toMatchObject({
      isUseProxySend: false,
      proxySendTargetChatId: undefined,
    });
  });

  test("copy mode 只接受领域联合类型中的值", () => {
    expect(copyModeValue("reverse")).toBe("reverse");
    expect(copyModeValue("nya")).toBe("nya");
    expect(copyModeValue("ja")).toBe("ja");
    expect(copyModeValue("plain")).toBeUndefined();
    expect(copyModeValue(null)).toBeUndefined();
  });
});
