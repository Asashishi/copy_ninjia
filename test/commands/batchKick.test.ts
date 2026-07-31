import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { JoinLogRecord } from "../../packages/types/diskIO/storage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const probeChatMembership = mock(
  async (_chatId: number, _userId: number): Promise<boolean | undefined> => true
);
const kickChatMemberWithOutcome = mock(
  async (_chatId: number, _userId: number): Promise<string> => "kicked"
);
const banChatMemberWithOutcome = mock(
  async (_chatId: number, _userId: number): Promise<string> => "banned"
);
const isUserBlocked = mock((_userId: number): boolean => false);
const requestBlocklistResweep = mock((_chatId: number): void => {});
const sweepBlockedMembers = mock(async (_chatId: number): Promise<void> => {});
const readRecentJoinLog = mock(
  async (..._args: unknown[]): Promise<readonly JoinLogRecord[]> => []
);
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/infra/config", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/config/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 100,
  hasWhitelistPermission: (): boolean => false,
}));
mock.module("../../packages/infra/blocklist", () => ({
  isUserBlocked,
  requestBlocklistResweep,
  sweepBlockedMembers,
}));
mock.module("../../packages/infra/joinLog", () => ({ readRecentJoinLog }));
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error: loggerError,
  },
}));
mock.module("../../packages/infra/telegram", () => ({
  sendMessage,
  probeChatMembership,
  kickChatMemberWithOutcome,
  banChatMemberWithOutcome,
}));

const {
  formatBatchKickDuration,
  handleBatchKickCommand,
  parseBatchKickDurationMs,
} = await import("../../packages/commands/batchKick");

interface ContextOverrides {
  userId?: number;
  match?: string;
  chatType?: string;
}

function context({
  userId = 1,
  match = "30m",
  chatType = "supergroup",
}: ContextOverrides = {}): never {
  return {
    chat: { id: -1001, type: chatType },
    from: { id: userId, first_name: "Admin" },
    msg: { message_id: 10 },
    msgId: 10,
    match,
  } as never;
}

function lastReplyText(): string {
  return (sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

beforeEach(() => {
  for (const mocked of [
    sendMessage,
    probeChatMembership,
    kickChatMemberWithOutcome,
    banChatMemberWithOutcome,
    isUserBlocked,
    requestBlocklistResweep,
    sweepBlockedMembers,
    readRecentJoinLog,
    loggerError,
  ]) {
    mocked.mockClear();
  }
  readRecentJoinLog.mockImplementation(async (): Promise<readonly JoinLogRecord[]> => []);
  probeChatMembership.mockImplementation(
    async (): Promise<boolean | undefined> => true
  );
  kickChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "kicked");
  banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "banned");
  isUserBlocked.mockImplementation((): boolean => false);
});

describe("parseBatchKickDurationMs", () => {
  test("只接受一天以内的 m/h/d 正整数", () => {
    expect(parseBatchKickDurationMs("30m")).toBe(30 * 60_000);
    expect(parseBatchKickDurationMs("2H")).toBe(2 * 60 * 60_000);
    expect(parseBatchKickDurationMs("1d")).toBe(24 * 60 * 60_000);
    for (const invalid of [
      "",
      "0m",
      "01m",
      "1.5h",
      "30",
      "30s",
      "25h",
      "2d",
      "999999999999999999999d",
    ]) {
      expect(parseBatchKickDurationMs(invalid)).toBeUndefined();
    }
  });

  test("战报使用最大整除单位", () => {
    expect(formatBatchKickDuration(30 * 60_000)).toBe("30 分钟");
    expect(formatBatchKickDuration(2 * 60 * 60_000)).toBe("2 小时");
    expect(formatBatchKickDuration(24 * 60 * 60_000)).toBe("1 天");
  });
});

describe("/batch_kick", () => {
  test("非超级管理员、非超级群和非法参数都在读盘前拒绝", async () => {
    await handleBatchKickCommand(context({ userId: 2 }));
    await handleBatchKickCommand(context({ chatType: "group" }));
    await handleBatchKickCommand(context({ match: "2d" }));

    expect(readRecentJoinLog).not.toHaveBeenCalled();
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    const groupReply: string =
      (sendMessage.mock.calls[1]?.[0] as { text: string }).text;
    expect(groupReply).toContain("只能在超级群");
    expect(groupReply).not.toContain("初始化");
    expect(lastReplyText()).toContain("只踢人");
  });

  test("读取失败时不执行任何踢人动作", async () => {
    const failure: Error = new Error("disk offline");
    readRecentJoinLog.mockRejectedValueOnce(failure);

    await handleBatchKickCommand(context());

    expect(loggerError).toHaveBeenCalledWith(
      "Failed to read join logs for /batch_kick in chat -1001:",
      failure
    );
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("一个人都没动");
  });

  test("空窗口明确报告未踢人、未写黑名单", async () => {
    await handleBatchKickCommand(context({ match: "2h" }));

    expect(readRecentJoinLog).toHaveBeenCalledTimes(1);
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("没有写入黑名单");
  });

  test("保护自己人，先查仍在群，再只踢确认在群的普通成员", async () => {
    readRecentJoinLog.mockResolvedValueOnce([
      { userId: 1, joinedAt: 1 },
      { userId: 100, joinedAt: 2 },
      { userId: 2, joinedAt: 3 },
      { userId: 3, joinedAt: 4 },
      { userId: 4, joinedAt: 5 },
      { userId: 5, joinedAt: 6 },
      { userId: 6, joinedAt: 7 },
    ]);
    probeChatMembership.mockImplementation(
      async (_chatId: number, userId: number): Promise<boolean | undefined> => {
        if (userId === 2) return false;
        if (userId === 3) return undefined;
        return true;
      }
    );
    kickChatMemberWithOutcome.mockImplementation(
      async (_chatId: number, userId: number): Promise<string> => {
        if (userId === 5) return "forbidden";
        if (userId === 6) return "failed";
        return "kicked";
      }
    );

    await handleBatchKickCommand(context());

    expect(probeChatMembership.mock.calls.map((call) => call[1]))
      .toEqual([2, 3, 4, 5, 6]);
    expect(kickChatMemberWithOutcome.mock.calls.map((call) => call[1]))
      .toEqual([4, 5, 6]);
    expect(lastReplyText()).toContain("踢出 1");
    expect(lastReplyText()).toContain("已不在群 1");
    expect(lastReplyText()).toContain("自己人跳过 2");
    expect(lastReplyText()).toContain("权限不足 1");
    expect(lastReplyText()).toContain("查询或请求失败 2");
    expect(lastReplyText()).toContain("只踢未拉黑");
  });

  test("已有黑名单成员不执行只踢，并单独计入交回封禁", async () => {
    readRecentJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((userId: number): boolean => userId === 42);

    await handleBatchKickCommand(context());

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(banChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("黑名单交回封禁 1");
  });

  test("只踢请求期间并发拉黑时补回永久封禁", async () => {
    let blocked: boolean = false;
    readRecentJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((): boolean => blocked);
    kickChatMemberWithOutcome.mockImplementation(
      async (): Promise<string> => {
        blocked = true;
        return "kicked";
      }
    );

    await handleBatchKickCommand(context());

    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 42);
    expect(requestBlocklistResweep).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("踢出 0");
    expect(lastReplyText()).toContain("黑名单交回封禁 1");
  });

  test("只踢返回不确定失败但名单已并发拉黑时仍补回永久封禁", async () => {
    let blocked: boolean = false;
    readRecentJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((): boolean => blocked);
    kickChatMemberWithOutcome.mockImplementation(
      async (): Promise<string> => {
        blocked = true;
        return "failed";
      }
    );

    await handleBatchKickCommand(context());

    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 42);
    expect(lastReplyText()).toContain("黑名单交回封禁 1");
    expect(lastReplyText()).toContain("查询或请求失败 0");
  });

  test("并发拉黑的补封失败时请求补扫且不报告踢出成功", async () => {
    let blocked: boolean = false;
    readRecentJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((): boolean => blocked);
    kickChatMemberWithOutcome.mockImplementation(
      async (): Promise<string> => {
        blocked = true;
        return "kicked";
      }
    );
    banChatMemberWithOutcome.mockResolvedValueOnce("failed");

    await handleBatchKickCommand(context());

    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
    expect(sweepBlockedMembers).toHaveBeenCalledWith(-1001);
    expect(lastReplyText()).toContain("踢出 0");
    expect(lastReplyText()).toContain("查询或请求失败 1");
  });
});
