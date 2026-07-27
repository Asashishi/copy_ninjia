import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const banChatMember = mock(async (..._args: unknown[]): Promise<boolean> => true);
const banChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const isChatMember = mock(async (..._args: unknown[]): Promise<boolean> => false);
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const isBotAdminIn = mock(async (_chatId: number): Promise<boolean> => false);
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (): Promise<CachedUser | undefined> => target);
const chatStates = new Map<number, { botIsAdmin?: boolean }>();
const postDiskIO = mock((..._args: unknown[]): boolean => true);

mock.module("../../packages/infra/config", () => ({ PRIVILEGED_USERS_ID: [100], SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/telegram", () => ({
  sendMessage,
  banChatMember,
  banChatSenderChat,
  isChatMember,
  deleteMessageAfter,
}));
// commands/block.ts 走 barrel，infra/blocklist.ts 直接走 actions 子模块；
// 两处都指向同一批替身，免得真实 client 被拉进来。
mock.module("../../packages/infra/telegram/actions", () => ({
  sendMessage,
  banChatMember,
  banChatSenderChat,
  isChatMember,
  deleteMessageAfter,
}));
mock.module("../../packages/infra/telegram/client", () => ({ joinVerificationApi: { kind: "guard-api" } }));
mock.module("../../packages/infra/botAdmin", () => ({ isBotAdminIn }));
mock.module("../../packages/infra/storage/stateStore", () => ({ getAllChatStates: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
const flushDiskIO = mock(async (): Promise<string> => "flushed");
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  // infra/logger.ts 从同一模块取它；整份模块被替换掉时缺了会在 import 阶段报错。
  relayLogMessage: (): boolean => true,
  // /block 只等黑名单这一个领域的落盘回执：统一 flush 是七个领域的合取，
  // 无关领域失败不该让它报「小本本没能写进硬盘」（见 confirmBlocklistPersisted）。
  flushDiskIODomain: flushDiskIO,
  lastFailedDiskIODomains: (): readonly string[] => [],
  flushDiskIO,
}));

const { handleBlockCommand } = await import("../../packages/commands/block");
const { blockedUserIds, blocklistSweepState, sessionBlockedAt } = await import("../../packages/cache/blocklist");

function context(userId: number | undefined = 100): never {
  return {
    chat: { id: -1001 },
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
    msg: { message_id: 10 },
    me: { id: 999 },
    match: "@alice",
  } as never;
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  chatStates.clear();
  for (const mocked of [
    sendMessage,
    banChatMember,
    banChatSenderChat,
    isChatMember,
    deleteMessageAfter,
    isBotAdminIn,
    resolveCommandTarget,
    postDiskIO,
    flushDiskIO,
  ]) mocked.mockClear();
  flushDiskIO.mockImplementation(async (): Promise<string> => "flushed");
  blockedUserIds.clear();
  sessionBlockedAt.clear();
  blocklistSweepState.clear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  banChatMember.mockImplementation(async (): Promise<boolean> => true);
  banChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  isChatMember.mockImplementation(async (): Promise<boolean> => false);
  isBotAdminIn.mockImplementation(async (): Promise<boolean> => false);
  postDiskIO.mockImplementation((): boolean => true);
});

describe("/block 跨群封禁与黑名单", () => {
  test("非白名单用户只收到拒绝，不探测管理员身份或目标", async () => {
    await handleBlockCommand(context(101));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(isBotAdminIn).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("目标解析失败或没有任何管理员群时不调用封禁 API", async () => {
    target = undefined;
    await handleBlockCommand(context());
    expect(banChatMember).not.toHaveBeenCalled();

    target = { id: 7, first_name: "Alice" };
    await handleBlockCommand(context());
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      // 一个管理群都没有也照样进名单，文案必须说清这一点。
      text: expect.stringMatching(/连一个群的管理员都不是.*已经记进小本本了/),
      replyToMessageId: 10,
    });
    expect(banChatMember).not.toHaveBeenCalled();
  });

  test("本群无权限时仍串行处理其它管理员群，并区分踢出、预封禁和失败", async () => {
    chatStates.set(-2002, { botIsAdmin: true });
    chatStates.set(-3003, { botIsAdmin: true });
    isChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    banChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await handleBlockCommand(context());

    expect(isChatMember.mock.calls.map((call) => call[0])).toEqual([-2002, -3003]);
    expect(banChatMember.mock.calls.map((call) => call[0])).toEqual([-2002, -3003]);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/这个群不是管理员.*从 1 个群一脚踢出去.*还有 1 个群没踢动/),
      replyToMessageId: 10,
    });
    expect(deleteMessageAfter).toHaveBeenCalledWith({
      chatId: -1001,
      messageId: 55,
      delayMs: expect.any(Number),
    });
  });

  test("频道马甲只调用 banChatSenderChat，不查询成员状态", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    isBotAdminIn.mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(banChatSenderChat).toHaveBeenCalledWith(-1001, -4004);
    expect(isChatMember).not.toHaveBeenCalled();
    expect(banChatMember).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("提前拉黑"),
      replyToMessageId: 10,
    });
  });

  test("当前群组皮套仍可被解析，但 /block 不会把整个群误当作匿名管理员封禁", async () => {
    target = { id: -1001, title: "Test Group", isChannel: true };
    isBotAdminIn.mockResolvedValueOnce(true);
    chatStates.set(-2002, { botIsAdmin: true });

    await handleBlockCommand(context());

    expect(banChatSenderChat).not.toHaveBeenCalled();
    expect(banChatMember).not.toHaveBeenCalled();
    expect(isChatMember).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("不会告诉本天才皮套底下是谁"),
      replyToMessageId: 10,
    });
  });

  test("所有群都封禁失败时给出权限诊断且不安排删除", async () => {
    isBotAdminIn.mockResolvedValueOnce(true);
    banChatMember.mockResolvedValueOnce(false);

    await handleBlockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/一个群都踢不动.*已经记进小本本了/),
      replyToMessageId: 10,
    });
    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });
});

describe("/block 的黑名单落盘", () => {
  test("先更新内存 Map 再投递落盘，封禁失败也照样入名单", async () => {
    // 投递时 Map 必须已经写好：两步之间到达的入群更新查的就是这个 Map，
    // 顺序反了那个人就这么进来了。
    postDiskIO.mockImplementation((): boolean => {
      expect(blockedUserIds.has(7)).toBeTrue();
      return true;
    });
    isBotAdminIn.mockResolvedValueOnce(true);
    banChatMember.mockResolvedValueOnce(false);

    await handleBlockCommand(context());

    expect(blockedUserIds.get(7)?.isBlocked).toBeTrue();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    const message = postDiskIO.mock.calls[0]![0] as { type: string; userId: number; blockedAt: string };
    expect(message.type).toBe("blockUser");
    expect(message.userId).toBe(7);
    // 东京时区的「YYYY/MM/DD HH:mm:ss」，与 libs/time.ts 的 formatTokyoTime 同形态。
    expect(message.blockedAt).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("重复拉黑同一个人会补投落盘，封禁也照做一遍", async () => {
    isBotAdminIn.mockResolvedValue(true);
    await handleBlockCommand(context());
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    banChatMember.mockClear();

    await handleBlockCommand(context());

    // 这个 id 是本进程新增的（在 sessionBlockedAt 里），上一次落盘可能压根没
    // 成功——管理员修好磁盘再跑一次 /block 正是最自然的重试动作，不能因为
    // 「Map 里已经有了」就静默跳过。封禁也重来一次：期间新加的群、上次失败
    // 的群靠这次补上。
    expect(postDiskIO).toHaveBeenCalledTimes(2);
    expect(banChatMember).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("早就在小本本上了"),
      replyToMessageId: 10,
    });
  });

  test("重复 /block 时落盘仍失败：战报照样说破，不能连着两次都说成功", async () => {
    isBotAdminIn.mockResolvedValue(true);
    flushDiskIO.mockResolvedValue("failed");

    await handleBlockCommand(context());
    await handleBlockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没能写进硬盘"),
      replyToMessageId: 10,
    });
  });

  test("启动时从文件读回来的 id 不再补投：它本来就在磁盘上", async () => {
    isBotAdminIn.mockResolvedValue(true);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleBlockCommand(context());

    expect(postDiskIO).not.toHaveBeenCalled();
    expect(flushDiskIO).not.toHaveBeenCalled();
  });

  test("封禁失败的群被标回「欠一次」补扫", async () => {
    // sweptAt 是永久闩锁，唯一的复位路径本来只有停管：这个群若早就扫过，
    // 被拉黑的人会一直待到进程结束——入群秒踢只对之后的入群更新生效。
    chatStates.set(-2002, { botIsAdmin: true });
    blocklistSweepState.set(-2002, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0 });
    banChatMember.mockResolvedValue(false);

    await handleBlockCommand(context());

    expect(blocklistSweepState.get(-2002)?.sweptAt).toBeNull();
  });

  test("封禁成功的群不必重扫", async () => {
    chatStates.set(-2002, { botIsAdmin: true });
    blocklistSweepState.set(-2002, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0 });

    await handleBlockCommand(context());

    expect(blocklistSweepState.get(-2002)?.sweptAt).toBe(1_000);
  });

  test("频道马甲同样进名单：id 就是 sender_chat 的 id", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    isBotAdminIn.mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(blockedUserIds.has(-4004)).toBeTrue();
  });

  test("自己人不可拉黑：超级管理员与白名单成员在入口就被挡住", async () => {
    // 名单只增不删，解除要停进程手工改文件（docs/04-invariants.md）。回错一条
    // 消息或用了过期的 @username 别名，就能把自己人永久锁在所有监听群之外，
    // 而机器人里没有任何撤销路径——只能在入口挡。
    for (const insiderId of [1, 100]) {
      target = { id: insiderId, first_name: "Insider" };
      await handleBlockCommand(context());
      expect(sendMessage).toHaveBeenLastCalledWith({
        chatId: -1001,
        text: expect.stringContaining("自己人"),
        replyToMessageId: 10,
      });
    }
    expect(blockedUserIds.size).toBe(0);
    expect(postDiskIO).not.toHaveBeenCalled();
    expect(banChatMember).not.toHaveBeenCalled();
  });

  test("落盘没成功时不把「永远」说出口，战报里说破重启会忘", async () => {
    flushDiskIO.mockResolvedValueOnce("failed");
    isBotAdminIn.mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    // 本进程内照样拦得住，但管理员必须知道这条记录还没进硬盘：写盘失败在
    // Worker 里只有 console.error，而那条日志按设计不会进 logs/。
    expect(blockedUserIds.has(7)).toBeTrue();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没能写进硬盘"),
      replyToMessageId: 10,
    });
  });

  test("匿名管理员皮套被拒时不写名单：那是整个群，不是某个人", async () => {
    target = { id: -1001, title: "Test Group", isChannel: true };
    isBotAdminIn.mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(blockedUserIds.size).toBe(0);
    expect(postDiskIO).not.toHaveBeenCalled();
  });
});
