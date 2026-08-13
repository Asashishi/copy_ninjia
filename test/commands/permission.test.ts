import { beforeEach, describe, expect, mock, test } from "bun:test";
import { NON_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";

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
const setWhitelistPermission = mock((): {
  changed: boolean;
  permissions: Record<string, boolean>;
} => ({ changed: true, permissions: {} }));
const enableAllWhitelistPermissions = mock((): {
  changed: boolean;
  permissions: Record<string, boolean>;
} => ({ changed: true, permissions: {} }));
const confirmWhitelistEntryPersisted = mock(
  async (_id: number, _retryUnacknowledged: boolean): Promise<void> => {}
);
const whitelistPermissionsById: Map<number, Record<string, boolean>> =
  new Map<number, Record<string, boolean>>();

function permissions(
  overrides: Record<string, boolean> = {}
): Record<string, boolean> {
  return {
    isCanMute: false,
    isCanUnMute: false,
    isCanGag: false,
    isCanViewBotStatus: true,
    isCanBlock: false,
    isCanUnBlock: false,
    isCanWhiteOther: false,
    isCanSwitchMood: false,
    isCanBypassAdDetection: true,
    isCanBypassFloodControl: true,
    isCanControllAIPermission: false,
    isCanControllAdDetectPermission: false,
    isCanControllFloodControlPermission: false,
    isCanControllJATranslatePermission: false,
    isCanControllAntiRaidPermission: false,
    ...overrides,
  };
}

/** 超级管理员的固定有效权限视图：逐项全开，且不来自 SQLite 白名单记录。 */
function allEnabledPermissions(): Record<string, boolean> {
  return permissions({
    isCanMute: true,
    isCanUnMute: true,
    isCanGag: true,
    isCanViewBotStatus: true,
    isCanBlock: true,
    isCanUnBlock: true,
    isCanWhiteOther: true,
    isCanSwitchMood: true,
    isCanControllAIPermission: true,
    isCanControllAdDetectPermission: true,
    isCanControllFloodControlPermission: true,
    isCanControllJATranslatePermission: true,
    isCanControllAntiRaidPermission: true,
  });
}

const getWhitelistPermissionQueryView = mock(
  (id: number): Readonly<Record<string, boolean>> =>
    id === 1
      ? allEnabledPermissions()
      : whitelistPermissionsById.get(id) ?? NON_WHITELIST_PERMISSIONS
);

mock.module("../../packages/config/telegram", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
// 1 是超级管理员：始终在白名单边界内、逐项权限全开，且永远不出现在
// whitelistPermissionsById（即已预热的 SQLite 白名单视图）里——照实模拟
// packages/infra/identityPolicy/whitelist.ts 那层只读覆盖。
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  confirmWhitelistEntryPersisted,
  hasWhitelistPermission: (id: number): boolean => id === 1,
  enableAllWhitelistPermissions,
  getWhitelistPermissionQueryView,
  isWhitelisted: (id: number): boolean =>
    id === 1 || whitelistPermissionsById.has(id),
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

/** 读取最后一条 query 回执里的 JSON 代码块。 */
function lastQueriedPermissions(): Record<string, boolean> {
  const message: SentMessage | undefined = sendMessage.mock.calls.at(-1)?.[0] as
    | SentMessage
    | undefined;
  const codeEntity: SentMessageEntity | undefined = message?.entities?.[0];
  const text: string = message?.text ?? "";
  return JSON.parse(text.slice(
    codeEntity?.offset ?? 0,
    (codeEntity?.offset ?? 0) + (codeEntity?.length ?? 0)
  )) as Record<string, boolean>;
}

beforeEach(() => {
  whitelistPermissionsById.clear();
  whitelistPermissionsById.set(100, permissions({ isCanMute: true }));
  sendMessage.mockClear();
  enableAllWhitelistPermissions.mockClear();
  getWhitelistPermissionQueryView.mockClear();
  setWhitelistPermission.mockClear();
  enableAllWhitelistPermissions.mockImplementation(() => ({
    changed: true,
    permissions: {},
  }));
  confirmWhitelistEntryPersisted.mockClear();
  confirmWhitelistEntryPersisted.mockImplementation(
    async (): Promise<void> => {}
  );
  setWhitelistPermission.mockImplementation(() => ({
    changed: true,
    permissions: {},
  }));
  userCache.clear();
  senderUsernameCache.clear();
});

describe("/permission", () => {
  test("权限键大小写不敏感，布尔值只接受 true/false", () => {
    expect(parseWhitelistPermissionKey("ISCANMUTE")).toBe("isCanMute");
    expect(parseWhitelistPermissionKey("ISCANVIEWBOTSTATUS")).toBe("isCanViewBotStatus");
    expect(parseWhitelistPermissionKey("ISCANCONTROLLFLOODCONTROLPERMISSION"))
      .toBe("isCanControllFloodControlPermission");
    expect(parseWhitelistPermissionKey("ISCANWHITEOTHER"))
      .toBe("isCanWhiteOther");
    expect(parseWhitelistPermissionKey("unknown")).toBeUndefined();
    expect(parsePermissionBoolean("TRUE")).toBe(true);
    expect(parsePermissionBoolean("false")).toBe(false);
    expect(parsePermissionBoolean("1")).toBeUndefined();
  });

  test("非超级管理员的单项与 all 写操作仍被拒绝，且不修改配置", async () => {
    await handlePermissionCommand(context(100, "100 isCanMute true"));
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/help 和 query 所有杂鱼都能用.*只有超级管理员才有资格/),
      replyToMessageId: 10,
    });

    await handlePermissionCommand(context(100, "100 all"));
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringMatching(/help 和 query 所有杂鱼都能用.*只有超级管理员才有资格/),
    }));
  });

  test("任何身份都可用 help 查看完整说明，且不触发写入", async () => {
    await handlePermissionCommand(context(2, "HELP"));

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
    expect(text).toContain("/permission query");
    expect(text).toContain("/permission query <用户id|@username>");
    expect(text).toContain("help 和 query 所有杂鱼都能用");
    expect(text).toContain("以下修改操作仅限超级管理员");
    expect(text).toContain("本天才");
    expect(text).toContain("杂鱼♡");
    expect(text).toContain("/permission <用户id|频道id|@username>");
    expect(text).toContain("/permission <用户id|频道id|@username> all");
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  test("白名单用户可用 query 查询自己的完整权限，查询回执不长期留存", async () => {
    const expected: Record<string, boolean> =
      whitelistPermissionsById.get(100)!;

    await handlePermissionCommand(context(100, "QUERY"));

    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    const message: SentMessage | undefined = sendMessage.mock.calls[0]?.[0] as
      | SentMessage
      | undefined;
    const codeEntity: SentMessageEntity | undefined = message?.entities?.[0];
    const text: string = message?.text ?? "";
    const permissionJson: string = text.slice(
      codeEntity?.offset ?? 0,
      (codeEntity?.offset ?? 0) + (codeEntity?.length ?? 0)
    );
    expect(codeEntity).toMatchObject({ type: "pre", language: "json" });
    expect(JSON.parse(permissionJson)).toEqual(expected);
    expect(text).toContain("本天才勉为其难");
    expect(text).toContain("true 是有这项权限");
    expect(text).toContain("false 就是没有");
    expect(text).toContain("杂鱼♡");
    expect(message?.preserveInGroup).toBeUndefined();
  });

  test("白名单频道按 sender_chat 查询自身权限，不泄漏附带用户的身份", async () => {
    const channelId: number = -1002233445566;
    whitelistPermissionsById.set(channelId, permissions({ isCanBlock: true }));
    const ctx = context(777, "query") as unknown as {
      msg: { sender_chat: object };
    };
    ctx.msg.sender_chat = {
      id: channelId,
      type: "channel",
      title: "Trusted Channel",
    };

    await handlePermissionCommand(ctx as never);

    const message: SentMessage | undefined = sendMessage.mock.calls[0]?.[0] as
      | SentMessage
      | undefined;
    const codeEntity: SentMessageEntity | undefined = message?.entities?.[0];
    const text: string = message?.text ?? "";
    expect(JSON.parse(text.slice(
      codeEntity?.offset ?? 0,
      (codeEntity?.offset ?? 0) + (codeEntity?.length ?? 0)
    ))).toEqual(whitelistPermissionsById.get(channelId));
  });

  test("非白名单身份 query 默认返回逐项 false，且不触发任何写入", async () => {
    await handlePermissionCommand(context(2, "query"));
    expect(lastQueriedPermissions()).toEqual(NON_WHITELIST_PERMISSIONS);
    expect(Object.values(lastQueriedPermissions()).every(
      (value: boolean): boolean => value === false
    )).toBeTrue();
    expect(getWhitelistPermissionQueryView).toHaveBeenCalledWith(2);
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
  });

  test("所有人都可通过回复、@username 或用户 ID 查询指定用户", async () => {
    const expectedWhitelistPermissions: Record<string, boolean> =
      whitelistPermissionsById.get(100)!;
    seedSenderCache({
      id: 100,
      username: "Alice",
      first_name: "Alice",
    });

    await handlePermissionCommand(context(2, "query @alice"));
    expect(lastQueriedPermissions()).toEqual(expectedWhitelistPermissions);
    expect(getWhitelistPermissionQueryView).toHaveBeenLastCalledWith(100);

    await handlePermissionCommand(context(2, "query 200"));
    expect(lastQueriedPermissions()).toEqual(NON_WHITELIST_PERMISSIONS);
    expect(getWhitelistPermissionQueryView).toHaveBeenLastCalledWith(200);

    await handlePermissionCommand(context(
      2,
      "query",
      {
        message_id: 9,
        chat: { id: -1001, type: "supergroup", title: "Test Group" },
        date: 1,
        from: { id: 100, is_bot: false, first_name: "Alice" },
      }
    ));
    expect(lastQueriedPermissions()).toEqual(expectedWhitelistPermissions);
    expect(getWhitelistPermissionQueryView).toHaveBeenLastCalledWith(100);
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
  });

  test("query 与授权分支同一道解析口径：频道 id 必须能读回来", async () => {
    // 授权分支开着 acceptChatId，query 分支缺了它的话，resolveArgumentTarget 会
    // 跳过 parseChatIdArgument，而 USERNAME_ARG_PATTERN 匹配不了前导 `-`，于是
    // 刚 /permission -100… isCanBlock true 授过权的频道身份反而读不回来。
    await handlePermissionCommand(context(2, "query -1002233445566"));

    expect(getWhitelistPermissionQueryView).toHaveBeenLastCalledWith(-1002233445566);
    const reply: SentMessage | undefined = sendMessage.mock.calls.at(-1)?.[0] as
      | SentMessage
      | undefined;
    expect(reply?.text ?? "").not.toContain("既不是合法的 Telegram 用户名");
  });

  test("超级管理员 query 拿到逐项全开的视图，即使 SQLite 没有其白名单记录", async () => {
    expect(whitelistPermissionsById.has(1)).toBeFalse();

    await handlePermissionCommand(context(1, "query"));

    const message: SentMessage | undefined = sendMessage.mock.calls[0]?.[0] as
      | SentMessage
      | undefined;
    const codeEntity: SentMessageEntity | undefined = message?.entities?.[0];
    const text: string = message?.text ?? "";
    const parsed: Record<string, boolean> = JSON.parse(text.slice(
      codeEntity?.offset ?? 0,
      (codeEntity?.offset ?? 0) + (codeEntity?.length ?? 0)
    )) as Record<string, boolean>;
    expect(parsed).toEqual(allEnabledPermissions());
    for (const key of WHITELIST_PERMISSION_KEYS) expect(parsed[key]).toBeTrue();
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
  });

  test("超级管理员自己不能被写进 SQLite 白名单表：单项与 all 都在入口挡住", async () => {
    await handlePermissionCommand(context(1, "1 isCanMute false"));
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就全开着"),
    }));

    await handlePermissionCommand(context(1, "1 all"));
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就全开着"),
    }));
    expect(whitelistPermissionsById.has(1)).toBeFalse();
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
    whitelistPermissionsById.set(channelId, permissions());
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
    enableAllWhitelistPermissions.mockImplementationOnce(() => ({
      changed: false,
      permissions: {},
    }));
    await handlePermissionCommand(context(1, "100 all"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就是全开的"),
    }));
  });

  test("all 落盘失败就地降级，如实回执而不是掀翻整个进程", async () => {
    enableAllWhitelistPermissions.mockImplementationOnce(
      (): never => {
        throw new Error("disk full");
      }
    );

    // 理由同 /white 那条：异常逸出会把一条命令变成永久重启循环，而配置此刻
    // 一点没被改动（见 commands/permission.ts 的 reportWhitelistMutationFailure）。
    await handlePermissionCommand(context(1, "100 all"));

    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能把这条权限写进硬盘"),
    }));
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
    whitelistPermissionsById.set(channelId, permissions());

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

  test("拒绝把当前群自己的身份当成授权目标（匿名管理员皮套）", async () => {
    // 这个 id 在白名单里也照挡：Telegram 不会告诉本进程皮套底下是谁，给它发
    // 权限等于把 /block、/mute 与各功能开关交给这个群的任意匿名管理员。
    whitelistPermissionsById.set(-1001, permissions());

    await handlePermissionCommand(context(1, "-1001 isCanBlock true"));
    expect(setWhitelistPermission).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("这是本群自己的身份"),
    }));

    sendMessage.mockClear();
    await handlePermissionCommand(context(1, "-1001 all"));
    expect(enableAllWhitelistPermissions).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("这是本群自己的身份"),
    }));
  });

  test("单项授权落盘失败就地降级，如实回执而不是掀翻整个进程", async () => {
    setWhitelistPermission.mockImplementationOnce((): never => {
      throw new Error("disk full");
    });

    await handlePermissionCommand(context(1, "100 isCanMute true"));

    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能把这条权限写进硬盘"),
    }));
  });

  test("事务确认失败不回执授权成功，幂等命中补投未确认 revision", async () => {
    setWhitelistPermission.mockImplementationOnce(() => ({
      changed: false,
      permissions: {},
    }));
    confirmWhitelistEntryPersisted.mockImplementationOnce(async (): Promise<void> => {
      throw new Error("missing exact ACK");
    });

    await handlePermissionCommand(context(1, "100 isCanMute true"));

    expect(confirmWhitelistEntryPersisted).toHaveBeenCalledWith(100, true);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能把这条权限写进硬盘"),
    }));
  });
});
