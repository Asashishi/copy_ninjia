import { beforeEach, describe, expect, mock, test } from "bun:test";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../packages/consts/identityStorage";
import type { JoinLogRecord } from "../../packages/types/diskIO/storage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const probeChatMembership = mock(
  async (_chatId: number, _userId: number): Promise<boolean | undefined> => true
);
const kickChatMemberWithOutcome = mock(
  async (_params: { chatId: number; userId: number }): Promise<string> => "kicked"
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
const prefetchIdentityPolicies = mock(
  async (_ids: readonly number[]): Promise<boolean> => true
);

// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../packages/config/telegram", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number): boolean => id === 1,
}));
mock.module("../../packages/infra/blocklist/membership", () => ({ isUserBlocked }));
mock.module("../../packages/infra/identityStorage", () => ({ prefetchIdentityPolicies }));
mock.module("../../packages/infra/blocklist/sweep", () => ({
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
  sendCommandMessage: sendMessage,
  probeChatMembership,
  kickChatMemberWithOutcome,
  banChatMemberWithOutcome,
}));

const {
  handleBatchKickCommand,
  parseBatchKickDurationMs,
} = await import("../../packages/commands/batchKick");

interface ContextOverrides {
  userId?: number;
  match?: string;
  chatType?: string;
}

/** 命令消息自带的 Telegram 秒级时间戳；窗口的「现在」由它决定，不是宿主时钟。 */
const COMMAND_DATE_SECONDS: number = 1_767_225_600;

function context({
  userId = 1,
  match = "30m",
  chatType = "supergroup",
}: ContextOverrides = {}): never {
  return {
    chat: { id: -1001, type: chatType },
    from: { id: userId, first_name: "Admin" },
    msg: { message_id: 10, date: COMMAND_DATE_SECONDS },
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
    prefetchIdentityPolicies,
  ]) {
    mocked.mockClear();
  }
  prefetchIdentityPolicies.mockImplementation(async (): Promise<boolean> => true);
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

  test("回溯窗口按命令消息自带的 Telegram 时间戳算，不掺宿主时钟", async () => {
    // 库里的 joinedAt 全部来自 `update.date`（见 antiRaid/updateIngress.ts）。这里
    // 若用 Date.now()，两个时钟直接相减，窗口边界就整体漂移出它们之间的偏差——
    // readJoinLog 既拿 since/now 逐条比 joinedAt，也拿它们算该读哪一两个日文件。
    await handleBatchKickCommand(context({ match: "2h" }));

    const now: number = COMMAND_DATE_SECONDS * 1_000;
    expect(readRecentJoinLog).toHaveBeenCalledWith({
      chatId: -1001,
      since: now - 2 * 60 * 60 * 1_000,
      now,
    });
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
      async ({ userId }: { chatId: number; userId: number }): Promise<string> => {
        if (userId === 5) return "forbidden";
        if (userId === 6) return "failed";
        return "kicked";
      }
    );

    await handleBatchKickCommand(context());

    expect(probeChatMembership.mock.calls.map((call) => call[1]))
      .toEqual([2, 3, 4, 5, 6]);
    expect(kickChatMemberWithOutcome.mock.calls.map((call) => call[0]?.userId))
      .toEqual([4, 5, 6]);
    expect(lastReplyText()).toContain("踢出 1");
    expect(lastReplyText()).toContain("已不在群 1");
    expect(lastReplyText()).toContain("自己人跳过 2");
    expect(lastReplyText()).toContain("权限不足 1");
    expect(lastReplyText()).toContain("查询或请求失败 2");
    expect(lastReplyText()).toContain("只踢未拉黑");
  });

  test("单条意外 rejection 带记录身份落日志，并继续结算同批其它成员", async () => {
    readRecentJoinLog.mockResolvedValueOnce([
      { userId: 7, joinedAt: 1 },
      { userId: 8, joinedAt: 2 },
    ]);
    probeChatMembership.mockImplementation(
      async (_chatId: number, userId: number): Promise<boolean> => {
        if (userId === 7) throw new Error("unexpected membership failure");
        return true;
      }
    );

    await handleBatchKickCommand(context());

    expect(kickChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(kickChatMemberWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      userId: 8,
      isSupergroup: true,
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/chat -1001, user 7, record 0, attempt 1/),
      expect.any(Error)
    );
    expect(lastReplyText()).toContain("踢出 1");
    expect(lastReplyText()).toContain("查询或请求失败 1");
  });

  test("429 等待期间目标已离群时按 absent 结算，不误报请求失败", async () => {
    readRecentJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }]);
    kickChatMemberWithOutcome.mockResolvedValueOnce("absent");

    await handleBatchKickCommand(context());

    expect(lastReplyText()).toContain("已不在群 1");
    expect(lastReplyText()).toContain("查询或请求失败 0");
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
    // 「交回」必须真的交出去：本命令对这条记录一步都没做，不请一次补扫的话
    // 战报那句话是空的，人还坐在群里而没有任何批次、清扫或重试存在。
    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
    expect(sweepBlockedMembers).toHaveBeenCalledWith(-1001);
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

describe("身份预取与批次消费必须交错", () => {
  test("每块预取严格小于身份 LRU 容量，且逐块与消费交错", async () => {
    const records: { userId: number; joinedAt: number }[] = [];
    for (let index: number = 0; index < IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 3; index++) {
      records.push({ userId: 1_000 + index, joinedAt: 1 });
    }
    readRecentJoinLog.mockResolvedValueOnce(records);
    const prefetchedAtCall: number[] = [];
    prefetchIdentityPolicies.mockImplementation(
      async (ids: readonly number[]): Promise<boolean> => {
        prefetchedAtCall.push(kickChatMemberWithOutcome.mock.calls.length);
        expect(ids.length).toBeLessThanOrEqual(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
        return true;
      }
    );

    await handleBatchKickCommand(context());

    // 一次全量预取的话第二块的 id 会把第一块整块挤出 LRU，轮到它们时白名单
    // 管理员会按冷未命中被踢出（见 consts/identityStorage.ts）。
    expect(prefetchIdentityPolicies).toHaveBeenCalledTimes(2);
    expect(prefetchedAtCall[0]).toBe(0);
    // 第二次预取发生在第一块**已经消费完**之后，而不是一开始就全部取完。
    expect(prefetchedAtCall[1]).toBe(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
    expect(lastReplyText()).toContain(`的 ${records.length} 条入群记录中的 ${records.length} 条`);
  });

  test("冷读失败时一个人都不动，并如实回执", async () => {
    readRecentJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }]);
    prefetchIdentityPolicies.mockImplementation(async (): Promise<boolean> => false);

    await handleBatchKickCommand(context());

    // 缺正/负结论时不能按「不在白名单」处置：那正是白名单管理员被误踢的路径。
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("一个人都没动");
  });

  test("中途冷读失败时只报已扫描的部分，并说明剩余没动", async () => {
    const records: { userId: number; joinedAt: number }[] = [];
    for (let index: number = 0; index < IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 3; index++) {
      records.push({ userId: 1_000 + index, joinedAt: 1 });
    }
    readRecentJoinLog.mockResolvedValueOnce(records);
    let call: number = 0;
    prefetchIdentityPolicies.mockImplementation(async (): Promise<boolean> => {
      call++;
      return call === 1;
    });

    await handleBatchKickCommand(context());

    expect(kickChatMemberWithOutcome).toHaveBeenCalledTimes(
      IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
    );
    expect(lastReplyText()).toContain(
      `的 ${records.length} 条入群记录中的 ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} 条`
    );
    expect(lastReplyText()).toContain("剩下的记录一条都没动");
  });
});
