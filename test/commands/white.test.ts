import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";
import { settleTestBatch } from "../libs/helpers";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const setWhitelistMembership = mock((): {
  changed: boolean;
  permissions: undefined;
} => ({ changed: true, permissions: undefined }));
const confirmWhitelistEntryPersisted = mock(
  async (_id: number, _retryUnacknowledged: boolean): Promise<void> => {}
);
const isUserBlocked = mock((_id: number): boolean => false);
const hasWhitelistPermission = mock(
  (_id: number, _key: string): boolean => false
);

mock.module("../../packages/config/telegram", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/whitelist", () => ({
  confirmWhitelistEntryPersisted,
  hasWhitelistPermission,
  setWhitelistMembership,
}));
mock.module("../../packages/infra/blocklist/membership", () => ({ isUserBlocked }));

const {
  handleWhiteCommand,
  parseWhiteAction,
} = await import("../../packages/commands/white");
const {
  seedSenderCache,
} = await import("../../packages/users/senderIdentity");
const {
  senderUsernameCache,
  userCache,
} = await import("../../packages/cache/main/senderIdentity");
const { protectedIdentityMutationQueue } =
  await import("../../packages/cache/main/blocklist");
const { runProtectedIdentityMutation } =
  await import("../../packages/infra/identityPolicy");

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

function repliedUser(id: number): object {
  return {
    message_id: 9,
    chat: { id: -1001, type: "supergroup", title: "Test Group" },
    date: 1,
    from: { id, is_bot: false, first_name: "Alice" },
  };
}

function repliedChannel(id: number): object {
  return {
    message_id: 9,
    chat: { id: -1001, type: "supergroup", title: "Test Group" },
    date: 1,
    from: { id: 777, is_bot: false, first_name: "Service User" },
    sender_chat: {
      id,
      type: "channel",
      title: "Trusted Channel",
    },
  };
}

beforeEach(() => {
  sendMessage.mockClear();
  setWhitelistMembership.mockClear();
  setWhitelistMembership.mockImplementation(() => ({
    changed: true,
    permissions: undefined,
  }));
  confirmWhitelistEntryPersisted.mockClear();
  confirmWhitelistEntryPersisted.mockImplementation(
    async (): Promise<void> => {}
  );
  isUserBlocked.mockClear();
  isUserBlocked.mockImplementation((): boolean => false);
  hasWhitelistPermission.mockClear();
  hasWhitelistPermission.mockImplementation((): boolean => false);
  protectedIdentityMutationQueue.current = Promise.resolve();
  userCache.clear();
  senderUsernameCache.clear();
});

describe("/white", () => {
  test("动作大小写不敏感且只接受 enable/disable", () => {
    expect(parseWhiteAction("ENABLE")).toBe("enable");
    expect(parseWhiteAction("disable")).toBe("disable");
    expect(parseWhiteAction("true")).toBeUndefined();
  });

  test("非超级管理员收到权限提示，且不修改白名单", async () => {
    await handleWhiteCommand(context(2, "100 enable"));

    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: expect.stringContaining("哪来的资格"),
      replyToMessageId: 10,
    });
  });

  test("持有 isCanWhiteOther 的普通白名单成员只能新增默认权限成员", async () => {
    hasWhitelistPermission.mockImplementation(
      (id: number, key: string): boolean =>
        id === 2 && key === "isCanWhiteOther"
    );

    await handleWhiteCommand(context(2, "100 enable"));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: 100,
      enabled: true,
      meta: { firstName: "", lastName: "", username: "" },
    });

    setWhitelistMembership.mockClear();
    await handleWhiteCommand(context(2, "100 disable"));
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("只准给其它身份添加默认权限白名单"),
    }));
  });

  test("支持 @username、用户 ID 与频道 ID", async () => {
    const alice: CachedUser = {
      id: 100,
      username: "Alice",
      first_name: "Alice",
    };
    seedSenderCache(alice);

    await handleWhiteCommand(context(1, "@alice enable"));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: 100,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "Alice" },
    });

    await handleWhiteCommand(context(1, "200 disable"));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: 200,
      enabled: false,
    });

    await handleWhiteCommand(context(1, "-1002233445566 enable"));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: -1002233445566,
      enabled: true,
      meta: { firstName: "", lastName: "", username: "" },
    });
  });

  test("回复用户或频道消息时只需提供 enable/disable", async () => {
    await handleWhiteCommand(context(1, "enable", repliedUser(100)));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: 100,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "" },
    });

    await handleWhiteCommand(context(
      1,
      "disable",
      repliedChannel(-1002233445566)
    ));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: -1002233445566,
      enabled: false,
    });
  });

  test("错误动作或缺少目标只回复用法，不触发写入", async () => {
    await handleWhiteCommand(context(1, "100 true"));
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("enable|disable"),
    }));

    sendMessage.mockClear();
    await handleWhiteCommand(context(1, "enable"));
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("回复"),
    }));
  });

  test("幂等结果给出准确回执，不宣称重复新增或删除成功", async () => {
    setWhitelistMembership.mockImplementation(() => ({
      changed: false,
      permissions: undefined,
    }));

    await handleWhiteCommand(context(1, "100 enable"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就在白名单"),
    }));

    await handleWhiteCommand(context(1, "200 disable"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就不在白名单"),
    }));
  });

  test("黑名单身份必须先 /unblock，不能直接加入白名单", async () => {
    isUserBlocked.mockImplementation(
      (id: number): boolean => id === 100 || id === -1002233445566
    );

    await handleWhiteCommand(context(1, "100 enable"));

    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("先用 /unblock"),
    }));

    await handleWhiteCommand(context(1, "-1002233445566 enable"));
    expect(setWhitelistMembership).not.toHaveBeenCalled();

    await handleWhiteCommand(context(1, "100 disable"));
    expect(setWhitelistMembership).toHaveBeenLastCalledWith({
      id: 100,
      enabled: false,
    });
  });

  test("成员关系变更等待既有黑名单策略临界区结束", async () => {
    let releaseEarlierMutation: (() => void) | undefined;
    const earlierMutation: Promise<void> = runProtectedIdentityMutation(
      (): Promise<void> => new Promise<void>((resolve: () => void): void => {
        releaseEarlierMutation = resolve;
      })
    );
    const whitelistUpdate: Promise<void> = handleWhiteCommand(context(1, "100 enable"));
    await Promise.resolve();
    await Promise.resolve();
    expect(setWhitelistMembership).not.toHaveBeenCalled();

    releaseEarlierMutation!();
    await settleTestBatch([earlierMutation, whitelistUpdate]);
    expect(setWhitelistMembership).toHaveBeenCalledTimes(1);
  });

  test("等待策略临界区期间权限被撤销时不沿用入口授权", async () => {
    let canWhiteOther: boolean = true;
    hasWhitelistPermission.mockImplementation(
      (_id: number, key: string): boolean =>
        key === "isCanWhiteOther" && canWhiteOther
    );
    let releaseEarlierMutation: (() => void) | undefined;
    const earlierMutation: Promise<void> = runProtectedIdentityMutation(
      (): Promise<void> => new Promise<void>((resolve: () => void): void => {
        releaseEarlierMutation = resolve;
      })
    );
    const whitelistUpdate: Promise<void> = handleWhiteCommand(
      context(2, "100 enable")
    );
    await Promise.resolve();
    await Promise.resolve();
    canWhiteOther = false;
    releaseEarlierMutation!();

    await settleTestBatch([earlierMutation, whitelistUpdate]);
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("哪来的资格"),
    }));
  });

  test("超级管理员自己 enable 被挡住，disable 仍可清掉表里的历史残留", async () => {
    await handleWhiteCommand(context(1, "1 enable"));
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("才不用塞进白名单表里"),
      replyToMessageId: 10,
    });

    // disable 只清表里的残留条目，清完超级管理员本人的权限一点不受影响
    // （权限来自身份，见 packages/whitelist.ts）。
    await handleWhiteCommand(context(1, "1 disable"));
    expect(setWhitelistMembership).toHaveBeenCalledWith({ id: 1, enabled: false });
    // 回执因此不能说成「已经从白名单里踢出去啦」：紧接着 /permission query
    // 仍会打印全开，那是一份与事实相反的战报。
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("残留条目已经被本天才清掉"),
    }));

    sendMessage.mockClear();
    setWhitelistMembership.mockImplementationOnce(() => ({
      changed: false,
      permissions: undefined,
    }));
    await handleWhiteCommand(context(1, "1 disable"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("本来就没有超级管理员的残留条目"),
    }));
  });

  test("拒绝把当前群自己的身份加进白名单（匿名管理员皮套）", async () => {
    // Telegram 只给 sender_chat=本群，皮套底下是谁永远查不到；加进白名单等于
    // 让这个群的匿名身份绕过广告检测与永久拉黑，还能被 /permission 授权。
    await handleWhiteCommand(context(1, "enable", repliedChannel(-1001)));
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("这是本群自己的身份"),
    }));

    // 直接把本群 id 粘进参数是同一个落点，同样要挡住。
    sendMessage.mockClear();
    await handleWhiteCommand(context(1, "-1001 enable"));
    expect(setWhitelistMembership).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("这是本群自己的身份"),
    }));
  });

  test("落盘失败就地降级，如实回执而不是掀翻整个进程", async () => {
    setWhitelistMembership.mockImplementationOnce((): never => {
      throw new Error("disk full");
    });

    // 不上抛：bot.catch 按设计原样重抛、acknowledged runner 随即带非零码退出
    // 且不确认 offset，Telegram 重投同一条命令——持久化边界持续异常时会形成
    // 永久重启循环，因此命令层必须就地收口并留下错误日志。
    await handleWhiteCommand(context(1, "100 enable"));

    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能把白名单写进硬盘"),
    }));
  });

  test("事务 flush 失败不回执成员关系成功，幂等命中要求补投未确认值", async () => {
    setWhitelistMembership.mockImplementationOnce(() => ({
      changed: false,
      permissions: undefined,
    }));
    confirmWhitelistEntryPersisted.mockImplementationOnce(async (): Promise<void> => {
      throw new Error("transaction failed");
    });

    await handleWhiteCommand(context(1, "100 enable"));

    expect(confirmWhitelistEntryPersisted).toHaveBeenCalledWith(100, true);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能把白名单写进硬盘"),
    }));
  });
});
