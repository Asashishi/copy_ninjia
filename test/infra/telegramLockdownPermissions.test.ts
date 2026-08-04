import { describe, expect, mock, test } from "bun:test";
import type { ChatPermissions } from "@grammyjs/types";
import { restoreLockdownInvitePermission } from "../../packages/infra/telegram/lockdownPermissions";

function apiWithPermissions(currentPermissions: ChatPermissions) {
  const getChat = mock(async () => ({ permissions: { ...currentPermissions } }));
  const setChatPermissions = mock(async (): Promise<boolean> => true);
  return { getChat, setChatPermissions };
}

describe("Anti-Raid lockdown permission restore boundary", () => {
  test("只恢复 invite 字段并保留管理员在锁定期间修改的其它权限", async () => {
    const api = apiWithPermissions({
      can_invite_users: false,
      can_send_messages: false,
      can_send_polls: true,
    });

    await restoreLockdownInvitePermission({
      chatId: -1001,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      api: api as never,
    });

    expect(api.getChat).toHaveBeenCalledWith(-1001);
    // 第三个参数不能省：不带 use_independent_chat_permissions 时 Bot API 会按
    // 蕴含规则把读回来的权限展开，一次锁定进出就把媒体权限全放开了。
    expect(api.setChatPermissions).toHaveBeenCalledWith(
      -1001,
      {
        can_invite_users: true,
        can_send_messages: false,
        can_send_polls: true,
      },
      { use_independent_chat_permissions: true }
    );
  });

  test("管理员已经主动开放邀请时不按旧权限重新关闭", async () => {
    const api = apiWithPermissions({ can_invite_users: true, can_send_messages: false });

    await restoreLockdownInvitePermission({
      chatId: -1002,
      originalPermissions: { can_invite_users: false, can_send_messages: true },
      api: api as never,
    });

    expect(api.setChatPermissions).toHaveBeenCalledWith(
      -1002,
      {
        can_invite_users: true,
        can_send_messages: false,
      },
      { use_independent_chat_permissions: true }
    );
  });

  test("getChat 缺少默认权限时拒绝写入，不能拿空对象覆盖群权限", async () => {
    const getChat = mock(async () => ({ id: -1003 }));
    const setChatPermissions = mock(async (): Promise<boolean> => true);

    await expect(restoreLockdownInvitePermission({
      chatId: -1003,
      originalPermissions: { can_invite_users: true },
      api: { getChat, setChatPermissions } as never,
    })).rejects.toThrow("getChat response missing permissions");
    expect(setChatPermissions).not.toHaveBeenCalled();
  });
});
