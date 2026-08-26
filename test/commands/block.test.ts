import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { BLOCK_COMMAND_CONCURRENCY } from "../../packages/consts/commands";
import { botPermissions } from "../helpers/botPermissions";
import {
  blockedIdentityTestView as blockedUserIds,
  seedMissingIdentity,
} from "../helpers/identityStorage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const banChatMember = mock(async (..._args: unknown[]): Promise<boolean> => true);
const banChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const isChatMember = mock(async (..._args: unknown[]): Promise<boolean> => false);
const resolveBotAdminStatus = mock(async (_chatId: number): Promise<boolean> => false);
const loggerError = mock((..._args: unknown[]): void => {});
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (): Promise<CachedUser | undefined> => {
  if (target !== undefined) seedMissingIdentity(target.id);
  return target;
});
const chatStates = new Map<number, { botPermissions?: BotChatPermissions }>();
const postDiskIO = mock((..._args: unknown[]): boolean => true);

// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../packages/config/telegram", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100 || id === -500,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || ((id === 100 || id === -500) && key === "isCanBlock"),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  banChatMember,
  banChatSenderChat,
  isChatMember,
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
mock.module("../../packages/infra/botAdmin", () => ({
  resolveBotAdminStatus,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({ getChatStateCache: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
const flushDiskIO = mock(async (): Promise<string> => "flushed");
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (): void => {},
  // infra/logger.ts 从同一模块取它；整份模块被替换掉时缺了会在 import 阶段报错。
  relayLogMessage: (): boolean => true,
  // /block 只等黑名单这一个领域的落盘回执：统一 flush 是九个领域的合取，
  // 无关领域失败不该让它报「小本本没能写进硬盘」（见 confirmBlocklistPersisted）。
  flushDiskIODomain: flushDiskIO,
  // confirmBlocklistPersisted 改用带回执的出口：失败领域名必须来自本次 flush。
  flushDiskIODomainOutcome: async (): Promise<{ result: string }> => ({ result: await flushDiskIO() }),
  flushDiskIO,
}));

const { handleBlockCommand } = await import("../../packages/commands/block");
const { blocklistSweepState } = await import("../../packages/cache/main/blocklist");

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
    resolveBotAdminStatus,
    loggerError,
    resolveCommandTarget,
    postDiskIO,
    flushDiskIO,
  ]) mocked.mockClear();
  flushDiskIO.mockImplementation(async (): Promise<string> => "flushed");
  blockedUserIds.clear();
  blocklistSweepState.clear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  banChatMember.mockImplementation(async (): Promise<boolean> => true);
  banChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  isChatMember.mockImplementation(async (): Promise<boolean> => false);
  resolveBotAdminStatus.mockImplementation(async (): Promise<boolean> => false);
  postDiskIO.mockImplementation((): boolean => true);
});

describe("/block 跨群封禁与黑名单", () => {
  test("非白名单用户只收到拒绝，不探测管理员身份或目标", async () => {
    await handleBlockCommand(context(101));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(resolveBotAdminStatus).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("超级管理员不必在 SQLite 白名单记录里配置 isCanBlock 也能 /block", async () => {
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleBlockCommand(context(1));

    expect(resolveCommandTarget).toHaveBeenCalledTimes(1);
    expect(blockedUserIds.has(7)).toBeTrue();
  });

  test("频道白名单按 sender_chat 身份授权，不误用附带的 from 用户", async () => {
    const ctx = context(101) as unknown as {
      msg: { message_id: number; sender_chat?: object };
    };
    ctx.msg.sender_chat = {
      id: -500,
      type: "channel",
      title: "Trusted Channel",
    };

    await handleBlockCommand(ctx as never);

    expect(resolveCommandTarget).toHaveBeenCalledTimes(1);
  });

  test("按裸 id 拉黑时战报念出 id，不写成泛指的兜底称呼", async () => {
    // resolveCommandTarget 对只给 id 的参数返回只带 id 的最小身份（缓存里没有
    // 这个人）。战报里必须能看出打的是哪个 id，否则打错一位数字没人看得出来。
    target = { id: 4242 };
    chatStates.set(-2002, { botPermissions: botPermissions() });

    await handleBlockCommand(context());

    const replies = sendMessage.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(replies.at(-1)).toContain("用户 4242");
    expect(replies.at(-1)).not.toContain("这个杂鱼");
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

  test("本群无权限时仍处理其它管理员群，并区分踢出、确认封禁和失败", async () => {
    chatStates.set(-2002, { botPermissions: botPermissions() });
    chatStates.set(-3003, { botPermissions: botPermissions() });
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
  });

  test("单群意外 rejection 不吞掉其它群结果，并把失败群交回补扫", async () => {
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    chatStates.set(-2002, { botPermissions: botPermissions() });
    blocklistSweepState.set(-1001, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });
    banChatMember
      .mockRejectedValueOnce(new Error("unexpected adapter rejection"))
      .mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(banChatMember).toHaveBeenCalledTimes(2);
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/在 1 个群确认封禁.*还有 1 个群没踢动/),
      replyToMessageId: 10,
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error while banning blocked identity 7 in chat -1001"),
      expect.any(Error)
    );
  });

  test("跨群封禁只启动固定小并发，完成项释放槽位后才取下一群", async () => {
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    for (let index: number = 0; index < BLOCK_COMMAND_CONCURRENCY + 3; index++) {
      chatStates.set(-2000 - index, { botPermissions: botPermissions() });
    }
    let active: number = 0;
    let peak: number = 0;
    let release: (() => void) | undefined;
    const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    banChatMember.mockImplementation(async (): Promise<boolean> => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
      return true;
    });

    const command: Promise<void> = handleBlockCommand(context());
    for (
      let step: number = 0;
      step < 10 && banChatMember.mock.calls.length < BLOCK_COMMAND_CONCURRENCY;
      step++
    ) {
      await Promise.resolve();
    }
    expect(banChatMember).toHaveBeenCalledTimes(BLOCK_COMMAND_CONCURRENCY);
    expect(peak).toBe(BLOCK_COMMAND_CONCURRENCY);

    release!();
    await command;
    expect(banChatMember).toHaveBeenCalledTimes(BLOCK_COMMAND_CONCURRENCY + 4);
    expect(peak).toBe(BLOCK_COMMAND_CONCURRENCY);
  });

  test("重复 /block 仍实时查询成员并重新封禁", async () => {
    resolveBotAdminStatus.mockResolvedValue(true);
    isChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await handleBlockCommand(context());
    expect(isChatMember).toHaveBeenCalledTimes(1);
    expect(banChatMember).toHaveBeenCalledTimes(1);

    await handleBlockCommand(context());

    // 第二次不复用第一次的“在群”历史：实时结果已经是不在群，所以只报告
    // 确认封禁；banChatMember 仍重发，让外部解封或重新入群得到重新结算。
    expect(isChatMember).toHaveBeenCalledTimes(2);
    expect(banChatMember).toHaveBeenCalledTimes(2);
    expect(banChatMember).toHaveBeenLastCalledWith(-1001, 7);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/在 1 个群确认封禁.*早就在小本本上了/),
      replyToMessageId: 10,
    });
  });

  test("确认不在群只报告确认封禁，不推断目标从未加入过", async () => {
    resolveBotAdminStatus.mockResolvedValue(true);
    isChatMember.mockResolvedValue(false);

    await handleBlockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/在 1 个群确认封禁/),
      replyToMessageId: 10,
    });
    expect((sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text)
      .not.toContain("根本没让 TA 进去过");
  });

  test("回复频道消息只封禁频道身份，不执行独立消息清理", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    const ctx = context() as unknown as {
      msg: { message_id: number; reply_to_message: { message_id: number } };
    };
    ctx.msg.reply_to_message = { message_id: 77 };

    await handleBlockCommand(ctx as never);

    expect(banChatSenderChat).toHaveBeenCalledWith(-1001, -4004);
    expect(isChatMember).not.toHaveBeenCalled();
    expect(banChatMember).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("确认封禁"),
      replyToMessageId: 10,
    });
  });

  test("当前群组皮套仍可被解析，但 /block 不会把整个群误当作匿名管理员封禁", async () => {
    target = { id: -1001, title: "Test Group", isChannel: true };
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    chatStates.set(-2002, { botPermissions: botPermissions() });

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

  test("所有群都封禁失败时给出权限诊断", async () => {
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    banChatMember.mockResolvedValueOnce(false);

    await handleBlockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringMatching(/一个群都踢不动.*已经记进小本本了/),
      replyToMessageId: 10,
    });
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
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    banChatMember.mockResolvedValueOnce(false);

    await handleBlockCommand(context());

    expect(blockedUserIds.get(7)?.isBlocked).toBeTrue();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    const message = postDiskIO.mock.calls[0]![0] as {
      type: string;
      table: string;
      id: number;
      data: string;
    };
    expect(message).toEqual(expect.objectContaining({
      type: "identityPolicyWrite",
      table: "blocklist",
      id: 7,
    }));
    expect(JSON.parse(message.data)).toEqual(expect.objectContaining({
      blockedAt: expect.stringMatching(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/),
      meta: expect.objectContaining({ username: "alice" }),
    }));
  });

  test("重复拉黑同一个人会补投落盘，并重新查询、封禁各群", async () => {
    resolveBotAdminStatus.mockResolvedValue(true);
    await handleBlockCommand(context());
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    banChatMember.mockClear();

    await handleBlockCommand(context());

    // 这个 id 是本进程新增的（在 sessionBlockedAt 里），上一次落盘可能压根没
    // 成功——管理员修好磁盘再跑一次 /block 正是最自然的重试动作，不能因为
    // 「Map 里已经有了」就静默跳过。成员状态每次实时查询，封禁也必须重发，
    // 让新加的群、上次失败的群和消息撤回都得到重新结算。
    expect(postDiskIO).toHaveBeenCalledTimes(2);
    expect(banChatMember).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("早就在小本本上了"),
      replyToMessageId: 10,
    });
  });

  test("重复 /block 时落盘仍失败：战报照样说破，不能连着两次都说成功", async () => {
    resolveBotAdminStatus.mockResolvedValue(true);
    flushDiskIO.mockResolvedValue("failed");

    await handleBlockCommand(context());
    await handleBlockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没能写进硬盘"),
      replyToMessageId: 10,
    });
  });

  test("SQLite 冷读命中的 id 没有未 ACK revision，不补投身份写入", async () => {
    resolveBotAdminStatus.mockResolvedValue(true);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleBlockCommand(context());

    expect(postDiskIO).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "identityPolicyWrite",
    }));
    expect(flushDiskIO).not.toHaveBeenCalled();
  });

  test("封禁失败的群被标回「欠一次」补扫", async () => {
    // sweptAt 是永久闩锁，唯一的复位路径本来只有停管：这个群若早就扫过，
    // 被拉黑的人会一直待到进程结束——入群秒踢只对之后的入群更新生效。
    chatStates.set(-2002, { botPermissions: botPermissions() });
    blocklistSweepState.set(-2002, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });
    banChatMember.mockResolvedValue(false);

    await handleBlockCommand(context());

    expect(blocklistSweepState.get(-2002)?.sweptAt).toBeNull();
  });

  test("封禁成功的群不必重扫", async () => {
    chatStates.set(-2002, { botPermissions: botPermissions() });
    blocklistSweepState.set(-2002, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });

    await handleBlockCommand(context());

    expect(blocklistSweepState.get(-2002)?.sweptAt).toBe(1_000);
  });

  test("频道马甲同样进名单：id 就是 sender_chat 的 id", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(blockedUserIds.has(-4004)).toBeTrue();
  });

  test("自己人不可拉黑：超级管理员与白名单成员在入口就被挡住", async () => {
    // 名单只增不删，解除要停进程手工改文件（docs/cn/04-invariants.md）。回错一条
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
    resolveBotAdminStatus.mockResolvedValueOnce(true);

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
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(blockedUserIds.size).toBe(0);
    expect(postDiskIO).not.toHaveBeenCalled();
  });
});
