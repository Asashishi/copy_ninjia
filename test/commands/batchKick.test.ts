import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../packages/consts/identityStorage";
import type { JoinLogRecord } from "../../packages/types/diskIO/storage";
import type { IdentityPolicyVerdicts } from "../../packages/types/identityStorage";
import { diskIOStub } from "../helpers/diskIOMock";
import { lastReplyText } from "../helpers/replies";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { IDENTITY_POLICY_UNAVAILABLE_TEXT } from "../../packages/consts/atmosphere/teasing/commands";
import { BATCH_KICK_CONCURRENCY } from "../../packages/consts/commands";
import { runWithUpdateAbortSignal } from "../../packages/infra/updateContext";
import { formatDurationCn } from "../../packages/libs/durationToken";
import { botPermissions } from "../helpers/botPermissions";

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
const readJoinLog = mock(
  async (..._args: unknown[]): Promise<readonly JoinLogRecord[]> => []
);
const loggerError = mock((..._args: unknown[]): void => {});
const EMPTY_VERDICTS: IdentityPolicyVerdicts = { whitelisted: new Set(), blocked: new Set() };
const readIdentityPolicyVerdicts = mock(
  async (_ids: readonly number[]): Promise<IdentityPolicyVerdicts | null> => EMPTY_VERDICTS
);

// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing", SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number): boolean => id === 1,
}));
mock.module("../../packages/infra/blocklist/membership", () => ({ isUserBlocked }));
mock.module("../../packages/infra/identityStorage", () => ({ readIdentityPolicyVerdicts }));
mock.module("../../packages/infra/blocklist/sweep", () => ({
  requestBlocklistResweep,
  sweepBlockedMembers,
}));
mock.module("../../packages/infra/diskIO", () => diskIOStub({ readJoinLog }));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
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
const { initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime } = await import("../../packages/cache/main/deferredCommands");
const { batchKickChats } = await import("../../packages/cache/main/batchKick");
const { getOrCreateChatState } = await import("../../packages/infra/storage/stateStore");

/** 等延迟命令执行器里已接纳的任务（含排队中的）全部结算。 */
async function settleDeferredCommands(): Promise<void> {
  const tasks: Set<Promise<void>> | undefined = deferredCommandRuntime.current?.tasks;
  while (tasks !== undefined && tasks.size > 0) await Promise.allSettled([...tasks]);
}

/** 默认窗口的「已受理」回执。 */
/** 本文件默认通知风格下的群提示文案表。 */
const NOTICES = ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS;

/** 战报的统计项；缺省为 0、未中断。 */
interface ResultStats {
  readonly recordCount: number;
  readonly scanned: number;
  readonly kicked?: number;
  readonly aborted?: boolean;
}

/** 按本用例的实际统计用常量渲染完整战报，窗口与 context() 缺省值一致。 */
function resultText({ recordCount, scanned, kicked = 0, aborted = false }: ResultStats): string {
  return NOTICES.batchKickResult({
    duration: formatDurationCn(30 * 60_000),
    recordCount,
    scanned,
    kicked,
    absent: 0,
    protected: 0,
    blocked: 0,
    forbidden: 0,
    failed: 0,
    abortedNotice: aborted ? NOTICES.batchKickAborted : "",
  });
}

function acceptedText(recordCount: number): string {
  return ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.batchKickAccepted({
    duration: formatDurationCn(30 * 60_000),
    recordCount,
  });
}

/** 处理命令并等后台批次结束：战报是最后一条回复。 */
async function runCommand(ctx: never): Promise<void> {
  await handleBatchKickCommand(ctx);
  await settleDeferredCommands();
}

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
  const chat = { id: -1001, type: chatType };
  return {
    chat,
    from: { id: userId, first_name: "Admin" },
    msg: { message_id: 10, date: COMMAND_DATE_SECONDS, chat },
    msgId: 10,
    match,
  } as never;
}

beforeEach(async () => {
  await settleDeferredCommands();
  initDeferredCommandRuntime();
  batchKickChats.clear();
  const chatState = getOrCreateChatState(-1001);
  chatState.isInitEnabled = true;
  chatState.botPermissions = undefined;
  for (const mocked of [
    sendMessage,
    probeChatMembership,
    kickChatMemberWithOutcome,
    banChatMemberWithOutcome,
    isUserBlocked,
    requestBlocklistResweep,
    sweepBlockedMembers,
    readJoinLog,
    loggerError,
    readIdentityPolicyVerdicts,
  ]) {
    mocked.mockClear();
  }
  readIdentityPolicyVerdicts.mockImplementation(
    async (): Promise<IdentityPolicyVerdicts | null> => EMPTY_VERDICTS
  );
  readJoinLog.mockImplementation(async (): Promise<readonly JoinLogRecord[]> => []);
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
    await runCommand(context({ userId: 2 }));
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.batchKickRejected,
      replyToMessageId: 10,
    });
    await runCommand(context({ chatType: "group" }));
    await runCommand(context({ match: "2d" }));

    expect(readJoinLog).not.toHaveBeenCalled();
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    const groupReply: string =
      (sendMessage.mock.calls[1]?.[0] as { text: string }).text;
    expect(groupReply).toBe(NOTICES.batchKickSupergroupOnly);
    expect(groupReply).not.toContain("初始化");
    expect(lastReplyText(sendMessage)).toContain("只踢人");
  });

  test("读取失败时不执行任何踢人动作", async () => {
    const failure: Error = new Error("disk offline");
    readJoinLog.mockRejectedValueOnce(failure);

    await runCommand(context());

    expect(loggerError).toHaveBeenCalledWith(
      "Failed to read join logs for /batch_kick in chat -1001:",
      failure
    );
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(NOTICES.joinLogUnavailable);
  });

  test("回溯窗口按命令消息自带的 Telegram 时间戳算，不掺宿主时钟", async () => {
    // 库里的 joinedAt 全部来自 `update.date`（见 antiRaid/updateIngress.ts）；窗口用同一个 Telegram 时间戳起算，
    // readJoinLog 既用 since/now 逐条比 joinedAt，也用它们算该读哪几个日文件。
    await runCommand(context({ match: "2h" }));

    const now: number = COMMAND_DATE_SECONDS * 1_000;
    expect(readJoinLog).toHaveBeenCalledWith({
      chatId: -1001,
      since: now - 2 * 60 * 60 * 1_000,
      now,
    });
  });

  test("空窗口明确报告未踢人、未写黑名单", async () => {
    await runCommand(context({ match: "2h" }));

    expect(readJoinLog).toHaveBeenCalledTimes(1);
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(NOTICES.batchKickEmpty(formatDurationCn(2 * 60 * 60_000)));
  });

  test("保护自己人，先查仍在群，再只踢确认在群的普通成员", async () => {
    readJoinLog.mockResolvedValueOnce([
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

    await runCommand(context());

    expect(probeChatMembership.mock.calls.map((call) => call[1]))
      .toEqual([2, 3, 4, 5, 6]);
    expect(kickChatMemberWithOutcome.mock.calls.map((call) => call[0]?.userId))
      .toEqual([4, 5, 6]);
    expect(lastReplyText(sendMessage)).toContain("踢出 1");
    expect(lastReplyText(sendMessage)).toContain("已不在群 1");
    expect(lastReplyText(sendMessage)).toContain("自己人跳过 2");
    expect(lastReplyText(sendMessage)).toContain("权限不足 1");
    expect(lastReplyText(sendMessage)).toContain("查询或请求失败 2");
    expect(lastReplyText(sendMessage)).toContain("只踢未拉黑");
  });

  test("单条意外 rejection 带记录身份落日志，并继续结算同批其它成员", async () => {
    readJoinLog.mockResolvedValueOnce([
      { userId: 7, joinedAt: 1 },
      { userId: 8, joinedAt: 2 },
    ]);
    probeChatMembership.mockImplementation(
      async (_chatId: number, userId: number): Promise<boolean> => {
        if (userId === 7) throw new Error("unexpected membership failure");
        return true;
      }
    );

    await runCommand(context());

    expect(kickChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(kickChatMemberWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      userId: 8,
      isSupergroup: true,
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/chat -1001, user 7, record 0:/),
      expect.any(Error)
    );
    expect(lastReplyText(sendMessage)).toContain("踢出 1");
    expect(lastReplyText(sendMessage)).toContain("查询或请求失败 1");
  });

  test("停机取消后不再处理剩余记录，在途失败不记日志，也不发战报", async () => {
    const records: { userId: number; joinedAt: number }[] = [];
    for (let index: number = 0; index < IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 3; index++) {
      records.push({ userId: 2_000 + index, joinedAt: 1 });
    }
    readJoinLog.mockResolvedValueOnce(records);
    const controller: AbortController = new AbortController();
    probeChatMembership.mockImplementation(async (): Promise<boolean | undefined> => {
      controller.abort(new DOMException("shutdown", "AbortError"));
      throw controller.signal.reason;
    });

    await runWithUpdateAbortSignal(
      controller.signal,
      (): Promise<void> => handleBatchKickCommand(context())
    );
    await settleDeferredCommands();

    // 只有取消前已经开始的那一轮并发探测，之后的记录与下一块一概不碰。
    expect(probeChatMembership.mock.calls.length).toBeLessThanOrEqual(BATCH_KICK_CONCURRENCY);
    expect(readIdentityPolicyVerdicts).toHaveBeenCalledTimes(1);
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(lastReplyText(sendMessage)).toBe(acceptedText(records.length));
    expect(batchKickChats.size).toBe(0);
  });

  test("有记录时先回已受理（带记录数与时长），后台批次结束后战报逐字照旧", async () => {
    readJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }, { userId: 43, joinedAt: 2 }]);

    await handleBatchKickCommand(context());
    expect(lastReplyText(sendMessage)).toBe(acceptedText(2));
    expect(batchKickChats.has(-1001)).toBeTrue();
    await settleDeferredCommands();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0]).toEqual({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.batchKickResult({
        duration: formatDurationCn(30 * 60_000),
        recordCount: 2,
        scanned: 2,
        kicked: 2,
        absent: 0,
        protected: 0,
        blocked: 0,
        forbidden: 0,
        failed: 0,
        abortedNotice: "",
      }),
      replyToMessageId: 10,
    });
    expect(batchKickChats.size).toBe(0);
  });

  test("后台等待位满时回忙，不登记批次也不动任何人", async () => {
    readJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }]);
    deferredCommandRuntime.current!.accepting = false;

    await runCommand(context());

    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.batchKickBusy);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(batchKickChats.size).toBe(0);
  });

  test("同群上一批未结束时回仍在处理；结束后可以再跑", async () => {
    readJoinLog.mockResolvedValue([{ userId: 42, joinedAt: 1 }]);
    const release: PromiseWithResolvers<boolean | undefined> = Promise.withResolvers<boolean | undefined>();
    probeChatMembership.mockImplementationOnce((): Promise<boolean | undefined> => release.promise);

    await handleBatchKickCommand(context());
    await handleBatchKickCommand(context());
    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.batchKickRunning);
    // 上一批还在跑时第二条命令不读日志。
    expect(readJoinLog).toHaveBeenCalledTimes(1);

    release.resolve(true);
    await settleDeferredCommands();
    expect(kickChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    await runCommand(context());
    expect(kickChatMemberWithOutcome).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["/init disable", (): void => { getOrCreateChatState(-1001).isInitEnabled = false; }],
    ["被撤管理员", (): void => {
      getOrCreateChatState(-1001).botPermissions = botPermissions({ isAdministrator: false });
    }],
  ] as const)("批次途中%s后不再处置剩余记录，也不发战报", async (_label: string, unmanage: () => void) => {
    readJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
      { userId: 43, joinedAt: 2 },
      { userId: 44, joinedAt: 3 },
      { userId: 45, joinedAt: 4 },
      { userId: 46, joinedAt: 5 },
      { userId: 47, joinedAt: 6 },
    ]);
    probeChatMembership.mockImplementationOnce(async (): Promise<boolean | undefined> => {
      unmanage();
      return true;
    });

    await runCommand(context());

    expect(probeChatMembership.mock.calls.length).toBeLessThanOrEqual(BATCH_KICK_CONCURRENCY);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(lastReplyText(sendMessage)).toBe(acceptedText(6));
    expect(batchKickChats.size).toBe(0);
  });

  test("429 等待期间目标已离群时按 absent 结算，不误报请求失败", async () => {
    readJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }]);
    kickChatMemberWithOutcome.mockResolvedValueOnce("absent");

    await runCommand(context());

    expect(lastReplyText(sendMessage)).toContain("已不在群 1");
    expect(lastReplyText(sendMessage)).toContain("查询或请求失败 0");
  });

  test("已有黑名单成员不执行只踢，并单独计入交回封禁", async () => {
    readJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((userId: number): boolean => userId === 42);

    await runCommand(context());

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(banChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toContain("黑名单交回封禁 1");
    // 「交回」必须真的交出去：请求一次补扫。
    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
    expect(sweepBlockedMembers).toHaveBeenCalledWith(-1001);
  });

  test("只踢请求期间并发拉黑时补回永久封禁", async () => {
    let blocked: boolean = false;
    readJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((): boolean => blocked);
    kickChatMemberWithOutcome.mockImplementation(
      async (): Promise<string> => {
        blocked = true;
        return "kicked";
      }
    );

    await runCommand(context());

    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 42);
    expect(requestBlocklistResweep).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toContain("踢出 0");
    expect(lastReplyText(sendMessage)).toContain("黑名单交回封禁 1");
  });

  test("只踢返回不确定失败但名单已并发拉黑时仍补回永久封禁", async () => {
    let blocked: boolean = false;
    readJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((): boolean => blocked);
    kickChatMemberWithOutcome.mockImplementation(
      async (): Promise<string> => {
        blocked = true;
        return "failed";
      }
    );

    await runCommand(context());

    expect(banChatMemberWithOutcome).toHaveBeenCalledWith(-1001, 42);
    expect(lastReplyText(sendMessage)).toContain("黑名单交回封禁 1");
    expect(lastReplyText(sendMessage)).toContain("查询或请求失败 0");
  });

  test("成员查询期间并发拉黑：不执行只踢，交回封禁并只请求一次补扫", async () => {
    let blocked: boolean = false;
    readJoinLog.mockResolvedValueOnce([
      { userId: 42, joinedAt: 1 },
    ]);
    isUserBlocked.mockImplementation((): boolean => blocked);
    probeChatMembership.mockImplementationOnce(async (): Promise<boolean | undefined> => {
      blocked = true;
      return true;
    });

    await runCommand(context());

    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(banChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(requestBlocklistResweep).toHaveBeenCalledTimes(1);
    expect(sweepBlockedMembers).toHaveBeenCalledTimes(1);
    expect(lastReplyText(sendMessage)).toContain("黑名单交回封禁 1");
  });

  test("补封失败且补扫派发也抛错时记日志、命令不抛，战报按失败结算", async () => {
    let blocked: boolean = false;
    readJoinLog.mockResolvedValueOnce([
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
    sweepBlockedMembers.mockRejectedValueOnce(new Error("sweep dispatch failed"));

    await runCommand(context());

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to dispatch the blocklist repair after /batch_kick in chat -1001"),
      expect.any(Error)
    );
    expect(lastReplyText(sendMessage)).toContain("踢出 0");
    expect(lastReplyText(sendMessage)).toContain("查询或请求失败 1");
  });

  test("并发拉黑的补封失败时请求补扫且不报告踢出成功", async () => {
    let blocked: boolean = false;
    readJoinLog.mockResolvedValueOnce([
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

    await runCommand(context());

    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
    expect(sweepBlockedMembers).toHaveBeenCalledWith(-1001);
    expect(lastReplyText(sendMessage)).toContain("踢出 0");
    expect(lastReplyText(sendMessage)).toContain("查询或请求失败 1");
  });
});

describe("身份结论按块直接冷读并与消费交错", () => {
  test("每块冷读严格小于身份 LRU 容量，且逐块与消费交错", async () => {
    const records: { userId: number; joinedAt: number }[] = [];
    for (let index: number = 0; index < IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 3; index++) {
      records.push({ userId: 1_000 + index, joinedAt: 1 });
    }
    readJoinLog.mockResolvedValueOnce(records);
    const readAtCall: number[] = [];
    readIdentityPolicyVerdicts.mockImplementation(
      async (ids: readonly number[]): Promise<IdentityPolicyVerdicts | null> => {
        readAtCall.push(kickChatMemberWithOutcome.mock.calls.length);
        expect(ids.length).toBeLessThanOrEqual(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
        return EMPTY_VERDICTS;
      }
    );

    await runCommand(context());

    expect(readIdentityPolicyVerdicts).toHaveBeenCalledTimes(2);
    expect(readAtCall[0]).toBe(0);
    // 第二次冷读发生在第一块已经消费完之后，不是一开始全部取完。
    expect(readAtCall[1]).toBe(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
    expect(lastReplyText(sendMessage)).toBe(resultText({
      recordCount: records.length,
      scanned: records.length,
      kicked: records.length,
    }));
  });

  test("局部结论为白名单时即使实时缓存已冷也不踢", async () => {
    // 42 不在 isWhitelisted mock 的白名单里，模拟处置期间被其它流量挤出 LRU。
    readJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }]);
    readIdentityPolicyVerdicts.mockImplementation(
      async (): Promise<IdentityPolicyVerdicts | null> => ({
        whitelisted: new Set([42]),
        blocked: new Set(),
      })
    );

    await runCommand(context());

    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
  });

  test("局部结论为黑名单时交回黑名单流程，不走只踢不封", async () => {
    readJoinLog.mockResolvedValueOnce([{ userId: 43, joinedAt: 1 }]);
    readIdentityPolicyVerdicts.mockImplementation(
      async (): Promise<IdentityPolicyVerdicts | null> => ({
        whitelisted: new Set(),
        blocked: new Set([43]),
      })
    );

    await runCommand(context());

    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(requestBlocklistResweep).toHaveBeenCalledWith(-1001);
  });

  test("冷读失败时一个人都不动，并如实回执", async () => {
    readJoinLog.mockResolvedValueOnce([{ userId: 42, joinedAt: 1 }]);
    readIdentityPolicyVerdicts.mockImplementation(
      async (): Promise<IdentityPolicyVerdicts | null> => null
    );

    await runCommand(context());

    // 缺正/负结论时不按「不在白名单」处置。
    expect(probeChatMembership).not.toHaveBeenCalled();
    expect(kickChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(IDENTITY_POLICY_UNAVAILABLE_TEXT);
  });

  test("中途冷读失败时只报已扫描的部分，并说明剩余没动", async () => {
    const records: { userId: number; joinedAt: number }[] = [];
    for (let index: number = 0; index < IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 3; index++) {
      records.push({ userId: 1_000 + index, joinedAt: 1 });
    }
    readJoinLog.mockResolvedValueOnce(records);
    let call: number = 0;
    readIdentityPolicyVerdicts.mockImplementation(
      async (): Promise<IdentityPolicyVerdicts | null> => {
        call++;
        return call === 1 ? EMPTY_VERDICTS : null;
      }
    );

    await runCommand(context());

    expect(kickChatMemberWithOutcome).toHaveBeenCalledTimes(
      IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
    );
    expect(lastReplyText(sendMessage)).toBe(resultText({
      recordCount: records.length,
      scanned: IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
      kicked: IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
      aborted: true,
    }));
  });
});
