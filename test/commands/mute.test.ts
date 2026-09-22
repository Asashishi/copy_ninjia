import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";
import { lastReplyText } from "../helpers/replies";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import {
  MUTE_DISPATCH_MIN_REMAINING_MS,
  MUTE_MAX_DURATION_MS,
  MUTE_MIN_DURATION_MS,
} from "../../packages/consts/commands";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const muteChatMemberWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "muted");
const unmuteChatMemberWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "unmuted");
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => target);
/** 本群机器人权限快照；默认是有「限制与封禁成员」的管理员，forbidden 只能来自目标一侧。 */
const RESTRICTING_ADMIN: BotChatPermissions = botPermissions({ canRestrictMembers: true });
const botChatPermissionsIn = mock(
  async (_chatId: number): Promise<BotChatPermissions | undefined> => RESTRICTING_ADMIN
);

// 1 是超级管理员：SQLite 没有其白名单记录，但由 packages/infra/identityPolicy/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing", SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  isWhitelisted: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || (id === 100 && (key === "isCanMute" || key === "isCanUnMute")),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  muteChatMemberWithOutcome,
  unmuteChatMemberWithOutcome,
}));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));
mock.module("../../packages/infra/botAdmin", () => ({ botChatPermissionsIn }));

const { handleMuteCommand, handleUnmuteCommand, parseMuteDurationMs } =
  await import("../../packages/commands/mute");
const originalDateNow: () => number = Date.now;

interface ContextOverrides {
  userId?: number;
  match?: string;
  chatType?: string;
}

function context({ userId = 100, match = "", chatType = "supergroup" }: ContextOverrides = {}): never {
  const chat = { id: -1001, type: chatType };
  return {
    chat,
    from: { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
    msg: { message_id: 10, chat },
    me: { id: 999 },
    match,
  } as never;
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  for (const mocked of [sendMessage, muteChatMemberWithOutcome, unmuteChatMemberWithOutcome, resolveCommandTarget, botChatPermissionsIn]) {
    mocked.mockClear();
  }
  botChatPermissionsIn.mockImplementation(async (): Promise<BotChatPermissions | undefined> => RESTRICTING_ADMIN);
  muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "muted");
  unmuteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "unmuted");
  Date.now = (): number => 1_000_000;
});

afterEach(() => {
  Date.now = originalDateNow;
});

describe("parseMuteDurationMs", () => {
  test("m/h/d 三种单位换算成毫秒，大小写均可", () => {
    expect(parseMuteDurationMs("10m")).toBe(10 * 60_000);
    expect(parseMuteDurationMs("2h")).toBe(2 * 60 * 60_000);
    expect(parseMuteDurationMs("1d")).toBe(24 * 60 * 60_000);
    expect(parseMuteDurationMs("90M")).toBe(90 * 60_000);
    expect(parseMuteDurationMs("365D")).toBe(MUTE_MAX_DURATION_MS);
  });

  test("越界值收敛到 Bot API 的临时禁言区间边界", () => {
    // 上限留一整天余量：Bot API 的永久禁言分界在 366 天，贴顶时排队耗时与
    // until_date 的向上取整会把它推过界（见 MUTE_MAX_DURATION_MS）。
    expect(MUTE_MAX_DURATION_MS).toBe(365 * 24 * 60 * 60_000);
    expect(parseMuteDurationMs("366d")).toBe(MUTE_MAX_DURATION_MS);
    expect(parseMuteDurationMs("500d")).toBe(MUTE_MAX_DURATION_MS);
    // 数值大到超出安全整数也只会更大，同样落在最大值上，不会绕回小数。
    expect(parseMuteDurationMs("99999999999999999999d")).toBe(MUTE_MAX_DURATION_MS);
    expect(parseMuteDurationMs("1m")).toBe(MUTE_MIN_DURATION_MS);
  });

  test("形态不合法一律返回 undefined，交给用法提示", () => {
    for (const bad of ["", "10", "m", "1.5h", "0m", "-5m", "10s", "10 m", "h10", "010m"]) {
      expect(parseMuteDurationMs(bad)).toBeUndefined();
    }
  });
});

describe("/mute 手动禁言", () => {
  test("非白名单用户只收到拒绝，不解析目标也不打请求", async () => {
    await handleMuteCommand(context({ userId: 101, match: "10m" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.muteRejected("@admin", "mute"),
      replyToMessageId: 10,
    });
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
  });

  test("非超级群直接拒绝：restrictChatMember 只对超级群有效", async () => {
    await handleMuteCommand(context({ match: "10m", chatType: "group" }));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("时长缺失或不合法回用法提示，且先于目标解析", async () => {
    for (const match of ["", "@alice", "@alice 10x", "10"]) {
      await handleMuteCommand(context({ match }));
    }
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(lastReplyText(sendMessage)).toContain("m/h/d");
  });

  test("末尾 token 是时长，其余整段作为目标参数传给解析层", async () => {
    await handleMuteCommand(context({ match: "@alice 10m" }));
    const resolveParams = resolveCommandTarget.mock.calls.at(-1)?.[0] as {
      rawArgument: string;
      acceptUserId: boolean;
      requireIdentityPolicies?: boolean;
    };
    expect(resolveParams.rawArgument).toBe("@alice");
    expect(resolveParams.acceptUserId).toBe(true);
    // 自己人闸读 isWhitelisted：名单预热失败时由解析层拒绝，不能按「不受保护」捂人。
    expect(resolveParams.requireIdentityPolicies).toBe(true);
    expect(muteChatMemberWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      userId: 7,
      mutedUntil: 1_000_000 + 10 * 60_000,
      dispatchTimeoutMs: 10 * 60_000 - MUTE_DISPATCH_MIN_REMAINING_MS,
    });
    expect(lastReplyText(sendMessage)).toContain("10 分钟");

    // 只有时长时目标参数为空，目标来自回复消息（由解析层处理）。
    await handleMuteCommand(context({ match: "2h" }));
    expect((resolveCommandTarget.mock.calls.at(-1)?.[0] as { rawArgument: string }).rawArgument).toBe("");
    expect(muteChatMemberWithOutcome).toHaveBeenLastCalledWith({
      chatId: -1001,
      userId: 7,
      mutedUntil: 1_000_000 + 2 * 60 * 60_000,
      dispatchTimeoutMs: 2 * 60 * 60_000 - MUTE_DISPATCH_MIN_REMAINING_MS,
    });
  });

  test("目标解析层因名单读不出来拒绝时不打请求、不再追加回执", async () => {
    target = undefined;
    await handleMuteCommand(context({ match: "777 10m" }));
    expect(resolveCommandTarget).toHaveBeenCalledTimes(1);
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("频道皮套与自己人都按不下去，不打请求", async () => {
    target = { id: -900, title: "Mask", isChannel: true };
    await handleMuteCommand(context({ match: "10m" }));
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();

    target = { id: 100, first_name: "Peer" };
    await handleMuteCommand(context({ match: "10m" }));
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toContain("自己人");

    // 超级管理员同样按不下去：他恒在白名单边界内。
    target = { id: 1, first_name: "Owner" };
    await handleMuteCommand(context({ match: "10m" }));
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toContain("自己人");
  });

  test("超级管理员不必在 SQLite 白名单记录里配置 isCanMute 也能 /mute", async () => {
    await handleMuteCommand(context({ userId: 1, match: "10m" }));

    expect(muteChatMemberWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      userId: 7,
      mutedUntil: 1_000_000 + 10 * 60_000,
      dispatchTimeoutMs: 10 * 60_000 - MUTE_DISPATCH_MIN_REMAINING_MS,
    });
  });

  test("forbidden 与 failed 两种失败分别措辞", async () => {
    muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText(sendMessage)).toContain("管理员");

    muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText(sendMessage)).toContain("再试");
  });

  test("forbidden 时按机器人权限快照点名原因：缺权限位不说成不是管理员", async () => {
    muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");

    botChatPermissionsIn.mockResolvedValueOnce(botPermissions());
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText(sendMessage)).toContain("是管理员，可没被勾上「限制与封禁成员」权限");
    expect(lastReplyText(sendMessage)).not.toContain("不是管理员");
    expect(lastReplyText(sendMessage)).not.toContain("要么");

    botChatPermissionsIn.mockResolvedValueOnce(botPermissions({ isAdministrator: false, canManageChat: false }));
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText(sendMessage)).toContain("还不是管理员");
    expect(lastReplyText(sendMessage)).toContain("「限制与封禁成员」");

    // 查不到快照或该位齐全时，两种成因都说给管理员听。
    botChatPermissionsIn.mockResolvedValueOnce(undefined);
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText(sendMessage)).toContain("要么");
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText(sendMessage)).toContain("要么");
  });

  test("成功与 failed 不查机器人权限快照", async () => {
    await handleMuteCommand(context({ match: "10m" }));
    muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    await handleMuteCommand(context({ match: "10m" }));
    expect(botChatPermissionsIn).not.toHaveBeenCalled();
  });
});

describe("/unmute 解除禁言", () => {
  test("成功解除时按目标打请求并播报", async () => {
    await handleUnmuteCommand(context({ match: "@alice" }));
    // 不读名单做决策，预热失败不拦解除。
    expect((resolveCommandTarget.mock.calls.at(-1)?.[0] as { requireIdentityPolicies?: boolean })
      .requireIdentityPolicies).toBeUndefined();
    expect(unmuteChatMemberWithOutcome).toHaveBeenCalledWith({ chatId: -1001, userId: 7 });
    expect(lastReplyText(sendMessage)).toContain("松开");
  });

  test("非白名单用户与非超级群同样被入口拦下", async () => {
    await handleUnmuteCommand(context({ userId: 101 }));
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.muteRejected("@admin", "unmute"),
      replyToMessageId: 10,
    });
    await handleUnmuteCommand(context({ chatType: "group" }));
    expect(resolveCommandTarget).not.toHaveBeenCalled();
    expect(unmuteChatMemberWithOutcome).not.toHaveBeenCalled();
  });

  test("自己人也能被捞：不设保护闸", async () => {
    target = { id: 100, first_name: "Peer" };
    await handleUnmuteCommand(context({ match: "" }));
    expect(unmuteChatMemberWithOutcome).toHaveBeenCalledWith({ chatId: -1001, userId: 100 });
  });

  test("频道皮套解不了，不打请求", async () => {
    target = { id: -900, title: "Mask", isChannel: true };
    await handleUnmuteCommand(context({}));
    expect(unmuteChatMemberWithOutcome).not.toHaveBeenCalled();
  });

  test("forbidden 与 failed 两种失败分别措辞", async () => {
    unmuteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");
    await handleUnmuteCommand(context({}));
    expect(lastReplyText(sendMessage)).toContain("管理员");

    unmuteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    await handleUnmuteCommand(context({}));
    expect(lastReplyText(sendMessage)).toContain("再试");
  });

  test("forbidden 且机器人缺限制权限时点名那一位", async () => {
    unmuteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");
    botChatPermissionsIn.mockResolvedValueOnce(botPermissions());
    await handleUnmuteCommand(context({}));
    expect(lastReplyText(sendMessage)).toContain("松不开");
    expect(lastReplyText(sendMessage)).toContain("是管理员，可没被勾上「限制与封禁成员」权限");
    expect(botChatPermissionsIn).toHaveBeenCalledWith(-1001);
  });
});
