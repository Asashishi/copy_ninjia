import { beforeEach, describe, expect, mock, test } from "bun:test";

interface SentMessageEntity {
  type: string;
  offset: number;
  length: number;
  language?: string;
}

interface SentMessage {
  text: string;
  entities?: readonly SentMessageEntity[];
  preserveInGroup?: boolean;
}

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const setWhitelistPermission = mock(async (): Promise<{
  changed: boolean;
  permissions: Record<string, boolean>;
}> => ({ changed: true, permissions: {} }));
const enableAllWhitelistPermissions = mock(async (): Promise<{
  changed: boolean;
  permissions: Record<string, boolean>;
}> => ({ changed: true, permissions: {} }));
const whitelistIds: Set<number> = new Set<number>();

mock.module("../../packages/infra/config", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/config/whitelist", () => ({
  hasWhitelistPermission: (): boolean => false,
  enableAllWhitelistPermissions,
  isWhitelisted: (id: number): boolean => whitelistIds.has(id),
  setWhitelistPermission,
}));

const {
  handlePermissionCommand,
  parsePermissionBoolean,
  parseWhitelistPermissionKey,
} = await import("../../packages/commands/permission");
const {
  WHITELIST_PERMISSION_HELP,
  WHITELIST_PERMISSION_KEYS,
} = await import("../../packages/consts/whitelist");
const {
  seedSenderCache,
} = await import("../../packages/users/senderIdentity");
const {
  senderUsernameCache,
  userCache,
} = await import("../../packages/cache/main/senderIdentity");

function context(
  userId: number,
  match: string,
  replyToMessage?: object
): never {
  return {
    chat: { id: -1001, type: "supergroup" },
    from: { id: userId, first_name: "Admin", username: "admin" },
    msg: {
      message_id: 10,
      ...(replyToMessage === undefined
        ? {}
        : { reply_to_message: replyToMessage }),
    },
    msgId: 10,
    me: { id: 999 },
    match,
  } as never;
}

beforeEach(() => {
  whitelistIds.clear();
  whitelistIds.add(100);
  sendMessage.mockClear();
  enableAllWhitelistPermissions.mockClear();
  setWhitelistPermission.mockClear();
  enableAllWhitelistPermissions.mockImplementation(async () => ({
    changed: true,
    permissions: {},
  }));
  setWhitelistPermission.mockImplementation(async () => ({
    changed: true,
    permissions: {},
  }));
  userCache.clear();
  senderUsernameCache.clear();
});

describe("/permission", () => {
  test("权限键大小写不敏感，布尔值只接受 true/false", () => {
    expect(parseWhitelistPermissionKey("ISCANMUTE")).toBe("isCanMute");
    expect(parseWhitelistPermissionKey("ISCANCONTROLLFLOODCONTROLPERMISSION"))
      .toBe("isCanControllFloodControlPermission");
    expect(parseWhitelistPermissionKey("unknown")).toBeUndefined();
    expect(parsePermissionBoolean("TRUE")).toBe(true);
    expect(parsePermissionBoolean("false")).toBe(false);
    expect(parsePermissionBoolean("1")).toBeUndefined();
  });

  test("非超级管理员收到权限提示，且不修改配置", async () => {
    await handlePermissionCommand(context(2, "100 isCanMute true"));
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: expect.stringContaining("哪来的资格"),
      replyToMessageId: 10,
    });
  });

  test("help 以 JSON 代码块列出全部权限与说明，且不触发写入", async () => {
    await handlePermissionCommand(context(1, "HELP"));

    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message: SentMessage | undefined = sendMessage.mock.calls[0]?.[0] as
      | SentMessage
      | undefined;
    const text: string = message?.text ?? "";
    const codeEntity: SentMessageEntity | undefined = message?.entities?.[0];
    expect(message?.preserveInGroup).toBeTrue();
    expect(codeEntity).toMatchObject({
      type: "pre",
      language: "json",
    });
    const permissionJson: string = text.slice(
      codeEntity?.offset ?? 0,
      (codeEntity?.offset ?? 0) + (codeEntity?.length ?? 0)
    );
    expect(JSON.parse(permissionJson)).toEqual(WHITELIST_PERMISSION_HELP);
    for (const key of WHITELIST_PERMISSION_KEYS) {
      expect(permissionJson).toContain(`"${key}"`);
      expect(permissionJson).toContain(
        JSON.stringify(WHITELIST_PERMISSION_HELP[key])
      );
    }
    expect(text).toContain("/permission <用户id|频道id|@username>");
    expect(text).toContain("/permission <用户id|频道id|@username> all");
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  test("all 支持 @username、用户/频道 ID 与回复目标", async () => {
    seedSenderCache({
      id: 100,
      username: "Alice",
      first_name: "Alice",
    });

    await handlePermissionCommand(context(1, "@alice all"));
    expect(enableAllWhitelistPermissions).toHaveBeenLastCalledWith(100);

    await handlePermissionCommand(context(1, "100 ALL"));
    expect(enableAllWhitelistPermissions).toHaveBeenLastCalledWith(100);

    const channelId: number = -1002233445566;
    whitelistIds.add(channelId);
    await handlePermissionCommand(context(1, `${channelId} all`));
    expect(enableAllWhitelistPermissions).toHaveBeenLastCalledWith(channelId);

    await handlePermissionCommand(context(
      1,
      "all",
      {
        message_id: 9,
        chat: { id: -1001, type: "supergroup", title: "Test Group" },
        date: 1,
        from: { id: 100, is_bot: false, first_name: "Alice" },
      }
    ));
    expect(enableAllWhitelistPermissions).toHaveBeenLastCalledWith(100);

    await handlePermissionCommand(context(
      1,
      "all",
      {
        message_id: 10,
        chat: { id: -1001, type: "supergroup", title: "Test Group" },
        date: 1,
        from: { id: 777, is_bot: false, first_name: "Service User" },
        sender_chat: {
          id: channelId,
          type: "channel",
          title: "Trusted Channel",
        },
      }
    ));
    expect(enableAllWhitelistPermissions).toHaveBeenLastCalledWith(channelId);
    expect(setWhitelistPermission).not.toHaveBeenCalled();
  });

  test("all 只修改已有白名单身份，并准确回复幂等结果", async () => {
    await handlePermissionCommand(context(1, "200 all"));
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("/white"),
    }));

    sendMessage.mockClear();
    enableAllWhitelistPermissions.mockImplementationOnce(async () => ({
      changed: false,
      permissions: {},
    }));
    await handlePermissionCommand(context(1, "100 all"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就是全开的"),
    }));
  });

  test("all 落盘失败不发送成功回执，让 update 保持失败以便重投", async () => {
    const failure = new Error("disk full");
    enableAllWhitelistPermissions.mockImplementationOnce(
      async (): Promise<never> => {
        throw failure;
      }
    );

    await expect(
      handlePermissionCommand(context(1, "100 all"))
    ).rejects.toBe(failure);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("超级管理员可按用户 ID 修改已有条目的单项权限", async () => {
    await handlePermissionCommand(context(1, "100 isCanMute true"));

    expect(setWhitelistPermission).toHaveBeenCalledWith({
      id: 100,
      key: "isCanMute",
      value: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("isCanMute 已设为 true"),
      replyToMessageId: 10,
    });
  });

  test("回复用户消息时可以省略 ID，直接修改该用户权限", async () => {
    await handlePermissionCommand(context(
      1,
      "isCanMute true",
      {
        message_id: 9,
        chat: { id: -1001, type: "supergroup", title: "Test Group" },
        date: 1,
        from: { id: 100, is_bot: false, first_name: "Alice" },
      }
    ));

    expect(setWhitelistPermission).toHaveBeenCalledWith({
      id: 100,
      key: "isCanMute",
      value: true,
    });
  });

  test("回复频道身份发送的消息时按 sender_chat 的负数 ID 授权", async () => {
    const channelId: number = -1002233445566;
    whitelistIds.add(channelId);

    await handlePermissionCommand(context(
      1,
      "isCanBypassAdDetection false",
      {
        message_id: 9,
        chat: { id: -1001, type: "supergroup", title: "Test Group" },
        date: 1,
        from: { id: 777, is_bot: false, first_name: "Service User" },
        sender_chat: {
          id: channelId,
          type: "channel",
          title: "Trusted Channel",
        },
      }
    ));

    expect(setWhitelistPermission).toHaveBeenCalledWith({
      id: channelId,
      key: "isCanBypassAdDetection",
      value: false,
    });
  });

  test("命令不能顺手新增白名单成员，错误参数也不会触发写入", async () => {
    await handlePermissionCommand(context(1, "200 isCanMute true"));
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("/white"),
    }));

    sendMessage.mockClear();
    await handlePermissionCommand(context(1, "100 isCanMute yes"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("true|false"),
    }));
  });

  test("落盘失败不发送成功回执，让 update 保持失败以便重投", async () => {
    const failure = new Error("disk full");
    setWhitelistPermission.mockImplementationOnce(async (): Promise<never> => {
      throw failure;
    });

    await expect(
      handlePermissionCommand(context(1, "100 isCanMute true"))
    ).rejects.toBe(failure);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
