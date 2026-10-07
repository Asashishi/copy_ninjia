import type { FlushResult } from "../../packages/types/lifecycle";
import { acknowledgeIdentityPolicyWrites, diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import type { IdentityStoragePersistedReply } from "../../packages/types/diskIO/replies";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { waitUntil } from "../helpers/waitUntil";
import { loggerStub } from "../helpers/loggerMock";
import type { CachedUser } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { MANAGED_CHAT_BATCH_CONCURRENCY } from "../../packages/consts/commands";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { botPermissions } from "../helpers/botPermissions";
import { describeBotPermissionGap } from "../../packages/libs/botPermissionGap";
import { formatTargetLabel } from "../../packages/users/userLabel";
import {
  blockedIdentityTestView as blockedUserIds,
  seedMissingIdentity,
} from "../helpers/identityStorage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const banChatMember = mock(async (..._args: unknown[]): Promise<boolean> => true);
const banChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
/** 发起群的机器人权限快照：默认确证不是管理员，用例按需换成管理员或未知。 */
const NOT_ADMIN_PERMISSIONS: BotChatPermissions = botPermissions({ isAdministrator: false, canManageChat: false });
const ADMIN_PERMISSIONS: BotChatPermissions = botPermissions({ canRestrictMembers: true });
/** 是管理员但没有「限制与封禁成员」：/block 对这类群不发封禁请求。 */
const NO_RESTRICT_PERMISSIONS: BotChatPermissions = botPermissions();
const NOTICES = ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS;
const botChatPermissionsIn = mock(
  async (_chatId: number): Promise<BotChatPermissions | undefined> => NOT_ADMIN_PERMISSIONS
);
const loggerError = mock((..._args: unknown[]): void => {});
let target: CachedUser | undefined;
/**
 * 与生产同构的桩：预热身份名单后，传了 currentChatTargetText 的调用在这一层挡下
 * 「当前群自己的频道身份」（见 commands/targetResolution.ts），命令侧只负责把文案
 * 传进来。真实闸的用例在 test/commands/targetResolution.test.ts。
 */
const resolveCommandTarget = mock(async (
  params: { chatId: number; message: { message_id: number }; currentChatTargetText?: string }
): Promise<CachedUser | undefined> => {
  if (target === undefined) return target;
  seedMissingIdentity(target.id);
  if (params.currentChatTargetText !== undefined && target.isChannel === true && target.id === params.chatId) {
    await sendMessage({ chatId: params.chatId, text: params.currentChatTargetText, replyToMessageId: params.message.message_id });
    return undefined;
  }
  return target;
});
const chatStates = new Map<number, { isInitEnabled?: boolean; botPermissions?: BotChatPermissions }>();
const postDiskIO = mock((..._args: unknown[]): boolean => true);

// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing", SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100 || id === -500,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || ((id === 100 || id === -500) && key === "isCanBlock"),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  banChatMember,
  banChatSenderChat,
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
mock.module("../../packages/infra/botAdmin", () => ({
  botChatPermissionsIn,
  // 与生产同构：读各群 ChatState 里的权限快照，没有记录即未知。
  botCanRestrictMembersIn: (chatId: number): boolean | undefined =>
    chatStates.get(chatId)?.botPermissions?.canRestrictMembers,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Record<string, never> => ({}), getChatStateCache: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
const handleBlockDisable = mock(async (_ctx: unknown, _targetArgument: string): Promise<void> => {});
mock.module("../../packages/commands/unblock", () => ({ handleBlockDisable }));
const flushDiskIO = mock(async (): Promise<FlushResult> => "flushed");
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
/** 为 false 时 flush 成功也不回执身份写入，模拟 Worker 尚未提交这批事务。 */
const identityAck: { enabled: boolean } = { enabled: true };

/** 黑名单确认等的是精确 revision ACK：flush 成功时先把已投递的身份写入回执出去。 */
async function flushBlocklistDomain(): Promise<{ result: FlushResult }> {
  const result: FlushResult = await flushDiskIO();
  if (result === "flushed" && identityAck.enabled) acknowledgeIdentityPolicyWrites(postDiskIO.mock.calls, persistedListeners);
  return { result };
}
mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  // /block 只等黑名单这一个领域的落盘回执：统一 flush 是各领域的合取，
  // 无关领域失败不让它报「小本本没能写进硬盘」（见 confirmBlocklistPersisted）。
  flushDiskIODomain: flushDiskIO,
  // confirmBlocklistPersisted 经 confirmIdentityPolicyPersisted 走带回执的出口，并核对精确 revision ACK。
  flushDiskIODomainOutcome: flushBlocklistDomain,
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListeners.push(listener);
    },
  }),
  flushDiskIO,
})));

const { handleBlockCommand } = await import("../../packages/commands/block");
const { blocklistSweepState } = await import("../../packages/cache/main/blocklist");

interface BlockResultExpectation {
  readonly bannedCount: number;
  readonly failedCount?: number;
  /** 本群未进清单时的原因短语（describeBotPermissionGap 的结果）。 */
  readonly hereGap?: string;
  readonly alreadyRecorded?: boolean;
}

/** 用生产文案函数拼出当前目标的完整战报；缺省为无失败、新记入名单、落盘成功。 */
function blockResultText({
  bannedCount,
  failedCount = 0,
  hereGap,
  alreadyRecorded = false,
}: BlockResultExpectation): string {
  return NOTICES.blockResult({
    skippedHereNote: hereGap === undefined ? "" : NOTICES.blockSkippedHere(hereGap),
    targetLabel: formatTargetLabel(target!, ATMOSPHERE_TEXTS.teasing),
    bannedCount,
    failedNote: failedCount > 0 ? NOTICES.blockPartialFailure(failedCount) : "",
    blocklistNote: alreadyRecorded ? NOTICES.blockAlreadyRecorded("") : NOTICES.blockRecorded(""),
  });
}

function context(userId: number | undefined = 100): never {
  const chat = { id: -1001, type: "supergroup" };
  return {
    chat,
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
    msg: { message_id: 10, chat },
    me: { id: 999 },
    match: "@alice enable",
  } as never;
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  chatStates.clear();
  for (const mocked of [
    handleBlockDisable,
    sendMessage,
    banChatMember,
    banChatSenderChat,
    botChatPermissionsIn,
    loggerError,
    resolveCommandTarget,
    postDiskIO,
    flushDiskIO,
  ]) mocked.mockClear();
  flushDiskIO.mockImplementation(async (): Promise<FlushResult> => "flushed");
  identityAck.enabled = true;
  blockedUserIds.clear();
  blocklistSweepState.clear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  banChatMember.mockImplementation(async (): Promise<boolean> => true);
  banChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  botChatPermissionsIn.mockImplementation(async (): Promise<BotChatPermissions | undefined> => NOT_ADMIN_PERMISSIONS);
  postDiskIO.mockImplementation((): boolean => true);
});

describe("/block 跨群封禁与黑名单", () => {

  test("末位动作缺省或不是 enable/disable 时只回用法提示，不解析目标也不分派", async () => {
    for (const match of ["", "@alice", "@alice block", "enable @alice"]) {
      const ctx = context() as unknown as { match: string };
      ctx.match = match;
      await handleBlockCommand(ctx as never);
    }
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(handleBlockDisable).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(4);
    for (const call of sendMessage.mock.calls) {
      expect(call[0]).toMatchObject({ chatId: -1001, replyToMessageId: 10, text: expect.stringContaining("disable") });
    }
  });

  test("disable 分派给解除流程，并只交出去掉动作后的目标参数", async () => {
    const ctx = context() as unknown as { match: string };
    ctx.match = "@alice DISABLE";
    await handleBlockCommand(ctx as never);
    expect(handleBlockDisable).toHaveBeenCalledWith(ctx, "@alice");
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("回复目标时只写动作，目标参数为空串", async () => {
    const ctx = context() as unknown as { match: string };
    ctx.match = "disable";
    await handleBlockCommand(ctx as never);
    expect(handleBlockDisable).toHaveBeenCalledWith(ctx, "");
  });
  test("非白名单用户只收到拒绝，不探测管理员身份或目标", async () => {
    await handleBlockCommand(context(101));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockRejected("@admin"),
      replyToMessageId: 10,
    });
    expect(botChatPermissionsIn).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("解析不出发起身份时同样拒绝，标签退化为未知发起人", async () => {
    const ctx = context() as unknown as { from?: object };
    delete ctx.from;
    await handleBlockCommand(ctx as never);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockRejected(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unknownActor),
      replyToMessageId: 10,
    });
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("超级管理员不必在 SQLite 白名单记录里配置 isCanBlock 也能 /block", async () => {
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);

    await handleBlockCommand(context(1));

    expect(resolveCommandTarget).toHaveBeenCalledTimes(1);
    expect(blockedUserIds.has(7)).toBeTrue();
  });

  test("目标名单预热失败由解析层拒绝：不写黑名单、不封禁、不追加回执", async () => {
    // 自己人闸与 blockUser 都读目标的名单结论，冷读失败时不当成「不受保护」。
    target = undefined;

    await handleBlockCommand(context(1));

    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({ requireIdentityPolicies: true }));
    expect(blockedUserIds.size).toBe(0);
    expect(banChatMember).not.toHaveBeenCalled();
    expect(postDiskIO).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
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
    // resolveCommandTarget 对只给 id 的参数返回只带 id 的最小身份（缓存里没有这个人）。
    target = { id: 4242 };
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });

    await handleBlockCommand(context());

    const replies = sendMessage.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(replies.at(-1)).toContain(NOTICES.userIdLabel(4242));
    expect(replies.at(-1)).not.toContain(NOTICES.unknownUser);
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

  test("其它群只算已 /init enable 的管理员群：是管理员但未接管的群不连坐", async () => {
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    chatStates.set(-3003, { botPermissions: ADMIN_PERMISSIONS });

    await handleBlockCommand(context());

    expect(banChatMember.mock.calls.map((call) => call[0])).toEqual([-2002]);
  });

  test("本群无权限时仍处理其它管理员群，并分别计数封禁与失败", async () => {
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    chatStates.set(-3003, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    banChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await handleBlockCommand(context());

    expect(banChatMember.mock.calls.map((call) => call[0])).toEqual([-2002, -3003]);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: blockResultText({
        bannedCount: 1,
        failedCount: 1,
        hereGap: describeBotPermissionGap(NOT_ADMIN_PERMISSIONS, "canRestrictMembers", NOTICES),
      }),
      replyToMessageId: 10,
    });
  });

  test("权限快照已确证缺封禁权限的群不发请求，计为失败并交回补扫", async () => {
    // 发起群是管理员但没有封禁权限：照样进清单，同样跳过。
    botChatPermissionsIn.mockResolvedValueOnce(NO_RESTRICT_PERMISSIONS);
    chatStates.set(-1001, { isInitEnabled: true, botPermissions: NO_RESTRICT_PERMISSIONS });
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    chatStates.set(-3003, { isInitEnabled: true, botPermissions: NO_RESTRICT_PERMISSIONS });
    for (const skippedChatId of [-1001, -3003]) {
      blocklistSweepState.set(skippedChatId, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });
    }

    await handleBlockCommand(context());

    expect(banChatMember.mock.calls.map((call) => call[0])).toEqual([-2002]);
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    expect(blocklistSweepState.get(-3003)?.sweptAt).toBeNull();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: blockResultText({ bannedCount: 1, failedCount: 2 }),
      replyToMessageId: 10,
    });
  });

  test("本群权限没查清时只说没查清，不说成不是管理员", async () => {
    botChatPermissionsIn.mockResolvedValueOnce(undefined);
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });

    await handleBlockCommand(context());

    expect(banChatMember.mock.calls.map((call) => call[0])).toEqual([-2002]);
    const text: string = (sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
    expect(text).toContain("这个群本天才踢不动 TA（本天才一时没查清自己在这个群的权限");
    expect(text).not.toContain("不是管理员");
  });

  test("单群意外 rejection 不吞掉其它群结果，并把失败群交回补扫", async () => {
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    blocklistSweepState.set(-1001, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });
    banChatMember
      .mockRejectedValueOnce(new Error("unexpected adapter rejection"))
      .mockResolvedValueOnce(true);

    await handleBlockCommand(context());

    expect(banChatMember).toHaveBeenCalledTimes(2);
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: blockResultText({ bannedCount: 1, failedCount: 1 }),
      replyToMessageId: 10,
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error while running ban blocked identity 7 in chat -1001"),
      expect.any(Error)
    );
  });

  test("跨群封禁只启动固定小并发，完成项释放槽位后才取下一群", async () => {
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);
    for (let index: number = 0; index < MANAGED_CHAT_BATCH_CONCURRENCY + 3; index++) {
      chatStates.set(-2000 - index, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
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
    await waitUntil((): boolean => banChatMember.mock.calls.length >= MANAGED_CHAT_BATCH_CONCURRENCY);
    expect(banChatMember).toHaveBeenCalledTimes(MANAGED_CHAT_BATCH_CONCURRENCY);
    expect(peak).toBe(MANAGED_CHAT_BATCH_CONCURRENCY);

    release!();
    await command;
    expect(banChatMember).toHaveBeenCalledTimes(MANAGED_CHAT_BATCH_CONCURRENCY + 4);
    expect(peak).toBe(MANAGED_CHAT_BATCH_CONCURRENCY);
  });

  test("跨群封禁与战报交给延迟命令执行器后台档：update 不等封禁，战报内容不变", async () => {
    const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
    initDeferredCommandRuntime();
    try {
      chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
      const banGate: PromiseWithResolvers<boolean> = Promise.withResolvers<boolean>();
      banChatMember.mockImplementationOnce(async (): Promise<boolean> => banGate.promise);

      await handleBlockCommand(context());

      // handler 已返回：名单已写入，封禁仍在后台等待，战报还没发。
      expect(blockedUserIds.has(7)).toBeTrue();
      await waitUntil((): boolean => banChatMember.mock.calls.length > 0);
      expect(banChatMember).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
      banGate.resolve(true);
      expect(await drainDeferredCommandRuntime(1_000)).toBe("flushed");
      expect(sendMessage).toHaveBeenLastCalledWith({
        chatId: -1001,
        text: blockResultText({
          bannedCount: 1,
          hereGap: describeBotPermissionGap(NOT_ADMIN_PERMISSIONS, "canRestrictMembers", NOTICES),
        }),
        replyToMessageId: 10,
      });
    } finally {
      await drainDeferredCommandRuntime(0);
    }
  });

  test("重复 /block 仍对各群重新封禁", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);

    await handleBlockCommand(context());
    expect(banChatMember).toHaveBeenCalledTimes(1);

    await handleBlockCommand(context());

    expect(banChatMember).toHaveBeenCalledTimes(2);
    expect(banChatMember).toHaveBeenLastCalledWith(-1001, 7);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: blockResultText({ bannedCount: 1, alreadyRecorded: true }),
      replyToMessageId: 10,
    });
  });

  test("每个受管群只发一次封禁请求，战报按封禁成功的群数计", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    chatStates.set(-3003, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });

    await handleBlockCommand(context());

    expect(banChatMember.mock.calls).toEqual([[-1001, 7], [-2002, 7], [-3003, 7]]);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: blockResultText({ bannedCount: 3 }),
      replyToMessageId: 10,
    });
  });

  test("回复频道消息只封禁频道身份，不执行独立消息清理", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);
    const ctx = context() as unknown as {
      msg: { message_id: number; reply_to_message: { message_id: number } };
    };
    ctx.msg.reply_to_message = { message_id: 77 };

    await handleBlockCommand(ctx as never);

    expect(banChatSenderChat).toHaveBeenCalledWith(-1001, -4004);
    expect(banChatMember).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: blockResultText({ bannedCount: 1 }),
      replyToMessageId: 10,
    });
  });

  test("当前群组皮套仍可被解析，但 /block 不会把整个群误当作匿名管理员封禁", async () => {
    target = { id: -1001, title: "Test Group", isChannel: true };
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });

    await handleBlockCommand(context());

    expect(banChatSenderChat).not.toHaveBeenCalled();
    expect(banChatMember).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockCurrentChat),
      replyToMessageId: 10,
    });
  });

  test("所有群都封禁失败时给出权限诊断", async () => {
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);
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
    // 投递落盘消息那一刻，内存 Map 已经写好。
    postDiskIO.mockImplementation((): boolean => {
      expect(blockedUserIds.has(7)).toBeTrue();
      return true;
    });
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);
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

  test("重复拉黑同一个人会补投未 ACK 的落盘，并重新查询、封禁各群", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);
    // 第一次的事务还没回执：记录仍是未 ACK 最终值。
    identityAck.enabled = false;
    await handleBlockCommand(context());
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockPersistFailed),
      replyToMessageId: 10,
    });
    banChatMember.mockClear();
    identityAck.enabled = true;

    await handleBlockCommand(context());

    // 重复调用不因「Map 里已经有了」而跳过：落盘补投一次，成员状态与封禁也重新结算。
    expect(postDiskIO).toHaveBeenCalledTimes(2);
    expect(banChatMember).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockAlreadyRecorded("")),
      replyToMessageId: 10,
    });
  });

  test("重复 /block 时落盘仍失败：战报照样说破，不能连着两次都说成功", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);
    flushDiskIO.mockResolvedValue("failed");

    await handleBlockCommand(context());
    await handleBlockCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockPersistFailed),
      replyToMessageId: 10,
    });
  });

  test("flush 报成功但 Worker 没回执这一 revision 时仍按没落盘回报", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);
    identityAck.enabled = false;

    await handleBlockCommand(context());

    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockPersistFailed),
      replyToMessageId: 10,
    });
    expect(loggerError).toHaveBeenCalledWith("Blocklist entry was not persisted to disk:", expect.any(Error));
  });

  test("已 ACK 的记录重复拉黑时不补投、不等 flush", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);
    await handleBlockCommand(context());
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);

    await handleBlockCommand(context());

    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
  });

  test("SQLite 冷读命中的 id 没有未 ACK revision，不补投身份写入", async () => {
    botChatPermissionsIn.mockResolvedValue(ADMIN_PERMISSIONS);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleBlockCommand(context());

    expect(postDiskIO).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "identityPolicyWrite",
    }));
    expect(flushDiskIO).not.toHaveBeenCalled();
  });

  test("封禁失败的群被标回「欠一次」补扫", async () => {
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    blocklistSweepState.set(-2002, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });
    banChatMember.mockResolvedValue(false);

    await handleBlockCommand(context());

    expect(blocklistSweepState.get(-2002)?.sweptAt).toBeNull();
  });

  test("封禁成功的群不必重扫", async () => {
    chatStates.set(-2002, { isInitEnabled: true, botPermissions: ADMIN_PERMISSIONS });
    blocklistSweepState.set(-2002, { removalId: null, sweptAt: 1_000, nextRetryAt: 0, resweepRequested: false, failedSweeps: 0, permissionBlocked: false });

    await handleBlockCommand(context());

    expect(blocklistSweepState.get(-2002)?.sweptAt).toBe(1_000);
  });

  test("频道马甲同样进名单：id 就是 sender_chat 的 id", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);

    await handleBlockCommand(context());

    expect(blockedUserIds.has(-4004)).toBeTrue();
  });

  test("自己人不可拉黑：超级管理员与白名单成员在入口就被挡住", async () => {
    // 黑名单只增不删，解除要停进程手工改文件（docs/cn/04-invariants.md），入口挡下。
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
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);

    await handleBlockCommand(context());

    // 本进程内照样拦得住，但回执必须说清这条记录还没进硬盘。
    expect(blockedUserIds.has(7)).toBeTrue();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.blockPersistFailed),
      replyToMessageId: 10,
    });
  });

  test("匿名管理员皮套被拒时不写名单：那是整个群，不是某个人", async () => {
    target = { id: -1001, title: "Test Group", isChannel: true };
    botChatPermissionsIn.mockResolvedValueOnce(ADMIN_PERMISSIONS);

    await handleBlockCommand(context());

    expect(blockedUserIds.size).toBe(0);
    expect(postDiskIO).not.toHaveBeenCalled();
  });
});
