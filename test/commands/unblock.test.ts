import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const unbanChatMemberIfBanned = mock(async (..._args: unknown[]): Promise<boolean> => true);
const unbanChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const isBotAdminIn = mock(async (_chatId: number): Promise<boolean> => false);
const chatStates = new Map<number, { botIsAdmin?: boolean }>();
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (): Promise<CachedUser | undefined> => target);
const postDiskIO = mock((..._args: unknown[]): boolean => true);
const flushDiskIO = mock(async (): Promise<string> => "flushed");

// 100 是普通白名单成员，1 是超级管理员：all 只有后者能用。
// 故意让超级管理员不在白名单里：SUPER_ADMIN_USER_ID 按设计是独立一批权限，
// 不走 PRIVILEGED_USERS_ID（见 infra/config.ts）。两者不重叠的部署必须照样能用。
mock.module("../../packages/infra/config", () => ({ PRIVILEGED_USERS_ID: [100], SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/telegram", () => ({
  sendMessage, deleteMessageAfter, unbanChatMemberIfBanned, unbanChatSenderChat,
}));
mock.module("../../packages/infra/telegram/actions", () => ({
  sendMessage, deleteMessageAfter, unbanChatMemberIfBanned, unbanChatSenderChat,
}));
mock.module("../../packages/infra/telegram/client", () => ({ joinVerificationApi: { kind: "guard-api" } }));
mock.module("../../packages/infra/botAdmin", () => ({ isBotAdminIn }));
mock.module("../../packages/infra/storage/stateStore", () => ({ getAllChatStates: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  relayLogMessage: (): boolean => true,
  flushDiskIODomain: flushDiskIO,
  lastFailedDiskIODomains: (): readonly string[] => [],
  flushDiskIO,
}));

const { handleUnblockCommand } = await import("../../packages/commands/unblock");
const {
  blockedUserIds,
  confirmedKickedUserIdsByChat,
  confirmedKickedUsersDay,
  sessionBlockedAt,
  sessionUnblockedIds,
} = await import("../../packages/cache/main/blocklist");
const {
  recordUserConfirmedKickedInChat,
  wasUserConfirmedKickedInChat,
} = await import("../../packages/infra/blocklist");
const { getTokyoDateKey } = await import("../../packages/libs/time");

function context(userId: number | undefined = 100, match: string = "@alice"): never {
  return {
    chat: { id: -1001 },
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
    msg: { message_id: 10 },
    me: { id: 999 },
    match,
  } as never;
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  chatStates.clear();
  for (const mocked of [
    sendMessage, deleteMessageAfter, resolveCommandTarget, postDiskIO, flushDiskIO,
    unbanChatMemberIfBanned, unbanChatSenderChat, isBotAdminIn,
  ]) mocked.mockClear();
  flushDiskIO.mockImplementation(async (): Promise<string> => "flushed");
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  postDiskIO.mockImplementation((): boolean => true);
  unbanChatMemberIfBanned.mockImplementation(async (): Promise<boolean> => true);
  unbanChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  isBotAdminIn.mockImplementation(async (): Promise<boolean> => false);
  blockedUserIds.clear();
  sessionBlockedAt.clear();
  sessionUnblockedIds.clear();
  confirmedKickedUserIdsByChat.clear();
  confirmedKickedUsersDay.current = null;
});

describe("/unblock", () => {
  test("非白名单用户只收到拒绝，不解析目标也不碰名单", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });

    await handleUnblockCommand(context(101));

    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(blockedUserIds.has(7)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("从内存 Map 删掉并投出整份重写，战报说清各群封禁不受影响", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    blockedUserIds.set(8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" });
    // 投递时内存必须已经删好：两步之间到达的入群更新查的就是这个 Map，
    // 顺序反了那个人还会白挨一次秒踢。
    postDiskIO.mockImplementation((): boolean => {
      expect(blockedUserIds.has(7)).toBeFalse();
      return true;
    });

    await handleUnblockCommand(context());

    expect(blockedUserIds.has(7)).toBeFalse();
    const message = postDiskIO.mock.calls[0]![0] as { type: string; userId: number; blocked: unknown[] };
    expect(message.type).toBe("unblockUser");
    expect(message.userId).toBe(7);
    expect(message.blocked).toEqual([[8, { isBlocked: true, blockedAt: "2026/07/25 19:38:10" }]]);
    // 名单只管「以后进群踢不踢」，各群已有的 Telegram 封禁是另一套东西，
    // 不说破的话管理员会以为人已经能回来了。
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/划掉.*各群解封/),
      replyToMessageId: 10,
    });
  });

  test("解除时失效该用户所有群的当日确证踢出缓存", async () => {
    const todayKey: string = getTokyoDateKey();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    recordUserConfirmedKickedInChat(-1001, 7, todayKey);
    recordUserConfirmedKickedInChat(-2002, 7, todayKey);
    recordUserConfirmedKickedInChat(-2002, 8, todayKey);

    await handleUnblockCommand(context());

    expect(wasUserConfirmedKickedInChat(-1001, 7, todayKey)).toBeFalse();
    expect(wasUserConfirmedKickedInChat(-2002, 7, todayKey)).toBeFalse();
    expect(wasUserConfirmedKickedInChat(-2002, 8, todayKey)).toBeTrue();
  });

  test("本来就不在名单里时不投递任何重写", async () => {
    await handleUnblockCommand(context());

    expect(postDiskIO).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("本来就不在本天才的小本本上"),
      replyToMessageId: 10,
    });
  });

  test("重写没落盘时说破：重启后这个人会回到名单上", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    flushDiskIO.mockResolvedValueOnce("failed");

    await handleUnblockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("重启后 TA 还会回到名单上"),
      replyToMessageId: 10,
    });
  });

  test("目标解析失败时不动名单", async () => {
    target = undefined;
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });

    await handleUnblockCommand(context());

    expect(blockedUserIds.has(7)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("频道马甲同样可以解除：id 就是 sender_chat 的 id", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    blockedUserIds.set(-4004, { isBlocked: true, blockedAt: "2026/07/25 19:40:00" });

    await handleUnblockCommand(context());

    expect(blockedUserIds.has(-4004)).toBeFalse();
    expect(sessionUnblockedIds.has(-4004)).toBeTrue();
  });

  test("匿名管理员皮套被拒：那是整个群，不是某个人", async () => {
    // 与 /block 同一道闸。放它过去的话 unbanChatSenderChat(chatId, chatId)
    // 自解封必然失败、落进 failedCount，管理员会收到一份关于「根本没被碰过的
    // 人」的假战报，还附带一条把运维引向没坏的群的权限诊断。
    target = { id: -1001, first_name: "Group", isChannel: true };
    blockedUserIds.set(-1001, { isBlocked: true, blockedAt: "2026/07/25 19:41:00" });

    await handleUnblockCommand(context());

    expect(blockedUserIds.has(-1001)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("皮套"),
      replyToMessageId: 10,
    });
  });

  test("匿名管理员皮套带 all 时也被拒：不能拿整个群去跨群解封", async () => {
    target = { id: -1001, first_name: "Group", isChannel: true };
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "all"));

    expect(unbanChatSenderChat).not.toHaveBeenCalled();
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
  });
});

describe("/unblock all（跨群解封）", () => {
  test("普通白名单成员用不了 all：波及面比「以后不再秒踢」大一档", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(100, "@alice all"));

    // 拒绝要发生在动名单之前：不能先把人放出来再说没权限。
    expect(blockedUserIds.has(7)).toBeTrue();
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("超级管理员"),
      replyToMessageId: 10,
    });
  });

  test("超级管理员：划掉名单并在所有管理群解封", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });
    chatStates.set(-3003, { botIsAdmin: true });
    chatStates.set(-4004, { botIsAdmin: false });
    isBotAdminIn.mockResolvedValueOnce(true);

    await handleUnblockCommand(context(1, "@alice all"));

    expect(blockedUserIds.has(7)).toBeFalse();
    // 本群排最前；botIsAdmin 不为 true 的群不进清单。
    expect(unbanChatMemberIfBanned.mock.calls.map((call) => call[0])).toEqual([-1001, -2002, -3003]);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/划掉.*在 3 个群把封禁一并解开/),
      replyToMessageId: 10,
    });
  });

  test("跨群解封完成时再次失效等待期间迟到的确证踢出缓存", async () => {
    const todayKey: string = getTokyoDateKey();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });
    unbanChatMemberIfBanned.mockImplementationOnce(async (): Promise<boolean> => {
      // 模拟另一个 chat lane 的 `/block` 在本命令 await Telegram 期间完成。
      recordUserConfirmedKickedInChat(-2002, 7, todayKey);
      return true;
    });

    await handleUnblockCommand(context(1, "@alice all"));

    expect(wasUserConfirmedKickedInChat(-2002, 7, todayKey)).toBeFalse();
  });

  test("不带 all 时一个群都不碰", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1));

    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("各群解封"),
      replyToMessageId: 10,
    });
  });

  test("回复目标消息时 all 是唯一参数，仍能解析出目标", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "all"));

    // 目标来自回复（resolveCommandTarget 替身），传下去的参数已经把 all 摘掉。
    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({ rawArgument: "" }));
    expect(unbanChatMemberIfBanned).toHaveBeenCalledTimes(1);
  });

  test("裸 id 与 all 混在一起时各自摘清楚，id 原样传给目标解析", async () => {
    // all 不是十进制数字也不够 5 个字符，既撞不上 USER_ID_ARG_PATTERN 也撞不上
    // USERNAME_ARG_PATTERN；摘掉它剩下的就是目标参数，顺序无关。
    target = { id: 4242 };
    blockedUserIds.set(4242, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "all 4242"));

    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({
      rawArgument: "4242",
      acceptUserId: true,
    }));
    expect(unbanChatMemberIfBanned).toHaveBeenCalledWith(-2002, 4242);
    // 缓存里没有这个人时回执念出 id，不写成泛指的兜底称呼。
    const replies = sendMessage.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(replies.at(-1)).toContain("用户 4242");
  });

  test("按频道的负数 id 划掉：这条命令单独开了 acceptChatId", async () => {
    // 频道马甲的 id 本来就会进名单（/block 回复频道消息、广告检测命中
    // sender_chat），可广告检测会删掉那条消息、没有公开 username 的频道也查不到
    // 缓存——不认负数 id 的话，这类条目永远划不掉，只能手改 blocklist.json。
    target = { id: -1002233445566, isChannel: true };
    blockedUserIds.set(-1002233445566, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "-1002233445566 all"));

    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({
      rawArgument: "-1002233445566",
      acceptUserId: true,
      acceptChatId: true,
    }));
    expect(blockedUserIds.has(-1002233445566)).toBeFalse();
    // isChannel 决定接口：拿负数去调成员解封会报错，被记进 failedCount 变成
    // 一份关于「根本没被碰过的目标」的假战报。
    expect(unbanChatSenderChat).toHaveBeenCalledWith(-2002, -1002233445566);
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    // 缓存落空时回执念成频道而不是用户，管理员才看得出目标被当成了哪一类。
    const replies = sendMessage.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(replies.at(-1)).toContain("频道 -1002233445566");
  });

  test("本来就不在名单里时，all 照样解封：那是这个参数的全部意义", async () => {
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "@alice all"));

    expect(unbanChatMemberIfBanned).toHaveBeenCalledWith(-2002, 7);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/本来就不在小本本上.*在 1 个群把封禁一并解开/),
      replyToMessageId: 10,
    });
  });

  test("部分群解封失败时说破还剩几个", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });
    chatStates.set(-3003, { botIsAdmin: true });
    unbanChatMemberIfBanned.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await handleUnblockCommand(context(1, "@alice all"));

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/在 1 个群把封禁一并解开.*还有 1 个群没解开/),
      replyToMessageId: 10,
    });
  });

  test("一个管理群都没有时说清解不了", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });

    await handleUnblockCommand(context(1, "@alice all"));

    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("一个群的管理员都不是"),
      replyToMessageId: 10,
    });
  });

  test("频道马甲走 unbanChatSenderChat，不碰成员解封接口", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    blockedUserIds.set(-4004, { isBlocked: true, blockedAt: "2026/07/25 19:40:00" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "@alice all"));

    expect(unbanChatSenderChat).toHaveBeenCalledWith(-2002, -4004);
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
  });
});

describe("超级管理员不在白名单里的部署", () => {
  test("仍能用 /unblock：SUPER_ADMIN_USER_ID 是独立的一批权限", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });

    await handleUnblockCommand(context(1));

    expect(blockedUserIds.has(7)).toBeFalse();
  });

  test("仍能用 all：否则唯一有资格的人反而被第一道门挡住", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/25 19:38:09" });
    chatStates.set(-2002, { botIsAdmin: true });

    await handleUnblockCommand(context(1, "@alice all"));

    expect(unbanChatMemberIfBanned).toHaveBeenCalledWith(-2002, 7);
  });
});
