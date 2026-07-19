import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../src/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const banChatMember = mock(async (..._args: unknown[]): Promise<boolean> => true);
const banChatSenderChat = mock(async (..._args: unknown[]): Promise<boolean> => true);
const isChatMember = mock(async (..._args: unknown[]): Promise<boolean> => false);
const deleteMessageAfter = mock((..._args: unknown[]): void => {});
const isBotAdminIn = mock(async (_chatId: number): Promise<boolean> => false);
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (): Promise<CachedUser | undefined> => target);
const chatStates = new Map<number, { botIsAdmin?: boolean }>();

mock.module("../../src/infra/config", () => ({ PRIVILEGED_USERS_ID: [100] }));
mock.module("../../src/infra/telegram", () => ({
  sendMessage,
  banChatMember,
  banChatSenderChat,
  isChatMember,
  deleteMessageAfter,
}));
mock.module("../../src/infra/botAdmin", () => ({ isBotAdminIn }));
mock.module("../../src/infra/storage/stateStore", () => ({ getAllChatStates: () => chatStates }));
mock.module("../../src/commands/targetResolution", () => ({ resolveCommandTarget }));

const { handleKickCommand } = await import("../../src/commands/kick");

function context(userId: number | undefined = 100): never {
  return {
    chat: { id: -1001 },
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
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
  ]) mocked.mockClear();
  sendMessage.mockImplementation(async (): Promise<number | undefined> => 55);
  banChatMember.mockImplementation(async (): Promise<boolean> => true);
  banChatSenderChat.mockImplementation(async (): Promise<boolean> => true);
  isChatMember.mockImplementation(async (): Promise<boolean> => false);
  isBotAdminIn.mockImplementation(async (): Promise<boolean> => false);
});

describe("/kick 跨群封禁", () => {
  test("非白名单用户只收到拒绝，不探测管理员身份或目标", async () => {
    await handleKickCommand(context(101));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(isBotAdminIn).not.toHaveBeenCalled();
    expect(resolveCommandTarget).not.toHaveBeenCalled();
  });

  test("目标解析失败或没有任何管理员群时不调用封禁 API", async () => {
    target = undefined;
    await handleKickCommand(context());
    expect(banChatMember).not.toHaveBeenCalled();

    target = { id: 7, first_name: "Alice" };
    await handleKickCommand(context());
    expect(sendMessage).toHaveBeenLastCalledWith(-1001, expect.stringContaining("连一个群的管理员都不是"), 10);
    expect(banChatMember).not.toHaveBeenCalled();
  });

  test("本群无权限时仍串行处理其它管理员群，并区分踢出、预封禁和失败", async () => {
    chatStates.set(-2002, { botIsAdmin: true });
    chatStates.set(-3003, { botIsAdmin: true });
    isChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    banChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await handleKickCommand(context());

    expect(isChatMember.mock.calls.map((call) => call[0])).toEqual([-2002, -3003]);
    expect(banChatMember.mock.calls.map((call) => call[0])).toEqual([-2002, -3003]);
    expect(sendMessage).toHaveBeenLastCalledWith(
      -1001,
      expect.stringMatching(/这个群不是管理员.*从 1 个群一脚踢出去.*还有 1 个群没踢动/),
      10
    );
    expect(deleteMessageAfter).toHaveBeenCalledWith(-1001, 55, expect.any(Number));
  });

  test("频道马甲只调用 banChatSenderChat，不查询成员状态", async () => {
    target = { id: -4004, first_name: "Channel", isChannel: true };
    isBotAdminIn.mockResolvedValueOnce(true);

    await handleKickCommand(context());

    expect(banChatSenderChat).toHaveBeenCalledWith(-1001, -4004);
    expect(isChatMember).not.toHaveBeenCalled();
    expect(banChatMember).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(-1001, expect.stringContaining("提前拉黑"), 10);
  });

  test("所有群都封禁失败时给出权限诊断且不安排删除", async () => {
    isBotAdminIn.mockResolvedValueOnce(true);
    banChatMember.mockResolvedValueOnce(false);

    await handleKickCommand(context());

    expect(sendMessage).toHaveBeenLastCalledWith(-1001, expect.stringContaining("一个群都踢不动"), 10);
    expect(deleteMessageAfter).not.toHaveBeenCalled();
  });
});
