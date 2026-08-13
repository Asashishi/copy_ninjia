import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";
import {
  blockedIdentityTestView as blockedUserIds,
  seedMissingIdentity,
} from "../helpers/identityStorage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const unbanChatMemberIfBanned = mock(async (..._args: unknown[]): Promise<boolean> => true);
const unbanChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const resolveBotAdminStatus = mock(async (_chatId: number): Promise<boolean> => false);
const chatStates: Map<number, { botIsAdmin?: boolean }> = new Map<
  number,
  { botIsAdmin?: boolean }
>();
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (): Promise<CachedUser | undefined> => {
  if (target !== undefined) seedMissingIdentity(target.id);
  return target;
});
const postDiskIO = mock((..._args: unknown[]): boolean => true);
const flushDiskIO = mock(async (): Promise<string> => "flushed");

mock.module("../../packages/config/telegram", () => ({ SUPER_ADMIN_USER_ID: 1 }));
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
  joinVerificationApi: { kind: "guard-api" },
}));
mock.module("../../packages/infra/botAdmin", () => ({ resolveBotAdminStatus }));
mock.module("../../packages/infra/storage/stateStore", () => ({ getAllChatStates: () => chatStates }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (): void => {},
  relayLogMessage: (): boolean => true,
  flushDiskIODomain: flushDiskIO,
  flushDiskIODomainOutcome: async (): Promise<{ result: string }> => ({ result: await flushDiskIO() }),
  flushDiskIO,
}));

const { handleUnblockCommand } = await import("../../packages/commands/unblock");
const { blocklistIdentityMutationQueues } = await import("../../packages/cache/main/blocklist");

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
  ]) mocked.mockClear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  postDiskIO.mockImplementation((): boolean => true);
  flushDiskIO.mockImplementation(async (): Promise<string> => "flushed");
  unbanChatMemberIfBanned.mockImplementation(async (): Promise<boolean> => true);
  unbanChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  resolveBotAdminStatus.mockImplementation(async (): Promise<boolean> => false);
});

describe("/unblock", () => {
  test("非授权身份不解析目标也不改名单", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    await handleUnblockCommand(context(101));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(blockedUserIds.has(7)).toBeTrue();
  });

  test("从 SQLite 视图移除后在所有管理员群解除真人封禁", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    chatStates.set(-2002, { botIsAdmin: true });
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
