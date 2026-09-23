import type { FlushResult } from "../../packages/types/lifecycle";
import { diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { CachedUser } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import {
  blockedIdentityTestView as blockedUserIds,
  seedMissingIdentity,
} from "../helpers/identityStorage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const unbanChatMemberIfBanned = mock(async (..._args: unknown[]): Promise<boolean> => true);
const unbanChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const resolveBotAdminStatus = mock(async (_chatId: number): Promise<boolean> => false);
const chatStates: Map<number, { botPermissions?: BotChatPermissions }> = new Map<
  number,
  { botPermissions?: BotChatPermissions }
>();
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
const loggerError = mock((..._args: unknown[]): void => {});
const postDiskIO = mock((..._args: unknown[]): boolean => true);
const flushDiskIO = mock(async (): Promise<FlushResult> => "flushed");

mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing", SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || (id === 100 && key === "isCanUnBlock"),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
mock.module("../../packages/infra/botAdmin", () => ({ resolveBotAdminStatus }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (): Record<string, never> => ({}), getChatStateCache: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  relayLogMessage: (): boolean => true,
  flushDiskIODomain: flushDiskIO,
  flushDiskIODomainOutcome: async (): Promise<{ result: FlushResult }> => ({ result: await flushDiskIO() }),
  flushDiskIO,
})));

const { handleBlockDisable } = await import("../../packages/commands/unblock");

/** `/block <目标> disable` 经 handleBlockCommand 去掉末位动作后交给解除流程的形态。 */
function handleUnblockCommand(ctx: never): Promise<void> {
  return handleBlockDisable(ctx, (ctx as { match: string }).match);
}
const { blocklistIdentityMutationQueues } = await import("../../packages/cache/main/blocklist");

function context(userId: number | undefined = 100, match: string = "@alice"): never {
  const chat = { id: -1001, type: "supergroup" };
  return {
    chat,
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
    msg: { message_id: 10, chat },
    me: { id: 999 },
    match,
  } as never;
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  chatStates.clear();
  blockedUserIds.clear();
  blocklistIdentityMutationQueues.clear();
  for (const mocked of [
    sendMessage,
    resolveCommandTarget,
    postDiskIO,
    flushDiskIO,
    unbanChatMemberIfBanned,
    unbanChatSenderChat,
    resolveBotAdminStatus,
    loggerError,
  ]) mocked.mockClear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIO.mockImplementation(async (): Promise<FlushResult> => "flushed");
  unbanChatMemberIfBanned.mockImplementation(async (): Promise<boolean> => true);
  unbanChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  resolveBotAdminStatus.mockImplementation(async (): Promise<boolean> => false);
});

describe("/block disable", () => {
  test("非授权身份不解析目标也不改名单", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    await handleUnblockCommand(context(101));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(blockedUserIds.has(7)).toBeTrue();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unblockRejected("@admin"),
      replyToMessageId: 10,
    });
  });

  test("解析不出发起身份时同样拒绝，标签退化为未知发起人", async () => {
    const ctx = context() as unknown as { from?: object };
    delete ctx.from;
    await handleUnblockCommand(ctx as never);
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unblockRejected(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unknownActor),
      replyToMessageId: 10,
    });
  });

  test("从 SQLite 视图移除后在所有管理员群解除真人封禁", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { botPermissions: botPermissions() });
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleUnblockCommand(context());

    expect(blockedUserIds.has(7)).toBeFalse();
    expect(unbanChatMemberIfBanned.mock.calls.map((call): unknown[] => call)).toEqual([
      [-1001, 7],
      [-2002, 7],
    ]);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("2 个群"),
    }));
  });

  test("目标名单预热失败由解析层拒绝：不回「本来就不在小本本上」，也不跨群解封", async () => {
    // unblockUser 按名单结论决定是否写 tombstone，冷读失败时不能当成「不在名单」。
    target = undefined;
    resolveBotAdminStatus.mockResolvedValue(true);

    await handleUnblockCommand(context(1, "777"));

    expect(resolveCommandTarget).toHaveBeenCalledWith(expect.objectContaining({ requireIdentityPolicies: true }));
    expect(postDiskIO).not.toHaveBeenCalled();
    expect(unbanChatMemberIfBanned).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("频道身份使用 unbanChatSenderChat，裸负 ID 可直接解除", async () => {
    target = { id: -4004, title: "Channel", isChannel: true };
    blockedUserIds.set(-4004, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    resolveBotAdminStatus.mockResolvedValueOnce(true);

    await handleUnblockCommand(context(1, "-4004"));

    expect(unbanChatSenderChat).toHaveBeenCalledWith(-1001, -4004);
    expect(blockedUserIds.has(-4004)).toBeFalse();
  });

  test("当前群自己的 sender_chat 身份仍在破坏性操作闸前拒绝", async () => {
    target = { id: -1001, title: "Current", isChannel: true };
    blockedUserIds.set(-1001, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    await handleUnblockCommand(context(1, "-1001"));

    expect(blockedUserIds.has(-1001)).toBeTrue();
    expect(unbanChatSenderChat).not.toHaveBeenCalled();
  });

  test("单群意外 rejection 只算这一个群失败，不掀掉其余群的解封", async () => {
    // 扇出与 /block 共用 runManagedChatBatch：常规 API 错误已由适配层归一化成
    // false，能抛到这里的是意外异常，逐项结算而不是让整条命令连同战报一起失败。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { botPermissions: botPermissions() });
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    unbanChatMemberIfBanned
      .mockRejectedValueOnce(new Error("unexpected adapter rejection"))
      .mockResolvedValueOnce(true);

    await handleUnblockCommand(context());

    expect(unbanChatMemberIfBanned).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringMatching(/在 1 个群把封禁一并解开了.*还有 1 个群没解开/),
    }));
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error while running lift the ban on identity 7 in chat -1001"),
      expect.any(Error)
    );
  });

  test("名单原本不存在仍执行 Telegram 解封，但不排队数据库 tombstone", async () => {
    seedMissingIdentity(7);
    resolveBotAdminStatus.mockResolvedValueOnce(true);
    await handleUnblockCommand(context());
    expect(unbanChatMemberIfBanned).toHaveBeenCalledTimes(1);
    expect(postDiskIO).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "identityPolicyWrite",
    }));
  });
});
