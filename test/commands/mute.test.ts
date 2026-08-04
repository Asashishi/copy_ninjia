import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CachedUser } from "../../packages/types/chatState";
import { MUTE_MAX_DURATION_MS, MUTE_MIN_DURATION_MS } from "../../packages/consts/commands";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 55);
const muteChatMemberWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "muted");
const unmuteChatMemberWithOutcome = mock(async (..._args: unknown[]): Promise<string> => "unmuted");
let target: CachedUser | undefined;
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => target);

// 1 是超级管理员：不在 config/whitelist.json 里，但由 packages/config/whitelist.ts
// 的读取边界直接算进白名单边界并持有全部权限，这里的 mock 照实模拟那层结论。
mock.module("../../packages/infra/config", () => ({ SUPER_ADMIN_USER_ID: 1 }));
mock.module("../../packages/config/whitelist", () => ({
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

const { handleMuteCommand, handleUnmuteCommand, parseMuteDurationMs, formatMuteDuration } =
  await import("../../packages/commands/mute");
const originalDateNow: () => number = Date.now;

interface ContextOverrides {
  userId?: number;
  match?: string;
  chatType?: string;
}

function context({ userId = 100, match = "", chatType = "supergroup" }: ContextOverrides = {}): never {
  return {
    chat: { id: -1001, type: chatType },
    from: { id: userId, first_name: "Admin", username: "admin" },
    msgId: 10,
    msg: { message_id: 10 },
    me: { id: 999 },
    match,
  } as never;
}

function lastReplyText(): string {
  return (sendMessage.mock.calls.at(-1)?.[0] as { text: string }).text;
}

beforeEach(() => {
  target = { id: 7, first_name: "Alice", username: "alice" };
  for (const mocked of [sendMessage, muteChatMemberWithOutcome, unmuteChatMemberWithOutcome, resolveCommandTarget]) {
    mocked.mockClear();
  }
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
    expect(parseMuteDurationMs("366D")).toBe(MUTE_MAX_DURATION_MS);
  });

  test("越界值收敛到 Bot API 的临时禁言区间边界", () => {
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

describe("formatMuteDuration", () => {
  test("按最大整除单位念，不替用户换算进位", () => {
    expect(formatMuteDuration(10 * 60_000)).toBe("10 分钟");
    expect(formatMuteDuration(90 * 60_000)).toBe("90 分钟");
    expect(formatMuteDuration(2 * 60 * 60_000)).toBe("2 小时");
    expect(formatMuteDuration(366 * 24 * 60 * 60_000)).toBe("366 天");
  });
});

describe("/mute 手动禁言", () => {
  test("非白名单用户只收到拒绝，不解析目标也不打请求", async () => {
    await handleMuteCommand(context({ userId: 101, match: "10m" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
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
    expect(lastReplyText()).toContain("m/h/d");
  });

  test("末尾 token 是时长，其余整段作为目标参数传给解析层", async () => {
    await handleMuteCommand(context({ match: "@alice 10m" }));
    const resolveParams = resolveCommandTarget.mock.calls.at(-1)?.[0] as { rawArgument: string; acceptUserId: boolean };
    expect(resolveParams.rawArgument).toBe("@alice");
    expect(resolveParams.acceptUserId).toBe(true);
    expect(muteChatMemberWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      userId: 7,
      mutedUntil: 1_000_000 + 10 * 60_000,
    });
    expect(lastReplyText()).toContain("10 分钟");

    // 只有时长时目标参数为空，目标来自回复消息（由解析层处理）。
    await handleMuteCommand(context({ match: "2h" }));
    expect((resolveCommandTarget.mock.calls.at(-1)?.[0] as { rawArgument: string }).rawArgument).toBe("");
    expect(muteChatMemberWithOutcome).toHaveBeenLastCalledWith({
      chatId: -1001,
      userId: 7,
      mutedUntil: 1_000_000 + 2 * 60 * 60_000,
    });
  });

  test("频道皮套与自己人都按不下去，不打请求", async () => {
    target = { id: -900, title: "Mask", isChannel: true };
    await handleMuteCommand(context({ match: "10m" }));
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();

    target = { id: 100, first_name: "Peer" };
    await handleMuteCommand(context({ match: "10m" }));
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("自己人");

    // 超级管理员同样按不下去：他恒在白名单边界内。
    target = { id: 1, first_name: "Owner" };
    await handleMuteCommand(context({ match: "10m" }));
    expect(muteChatMemberWithOutcome).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain("自己人");
  });

  test("超级管理员不必在 config/whitelist.json 里配 isCanMute 也能 /mute", async () => {
    await handleMuteCommand(context({ userId: 1, match: "10m" }));

    expect(muteChatMemberWithOutcome).toHaveBeenCalledWith({
      chatId: -1001,
      userId: 7,
      mutedUntil: 1_000_000 + 10 * 60_000,
    });
  });

  test("forbidden 与 failed 两种失败分别措辞", async () => {
    muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "forbidden");
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText()).toContain("管理员");

    muteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    await handleMuteCommand(context({ match: "10m" }));
    expect(lastReplyText()).toContain("再试");
  });
});

describe("/unmute 解除禁言", () => {
  test("成功解除时按目标打请求并播报", async () => {
    await handleUnmuteCommand(context({ match: "@alice" }));
    expect(unmuteChatMemberWithOutcome).toHaveBeenCalledWith({ chatId: -1001, userId: 7 });
    expect(lastReplyText()).toContain("松开");
  });

  test("非白名单用户与非超级群同样被入口拦下", async () => {
    await handleUnmuteCommand(context({ userId: 101 }));
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
    expect(lastReplyText()).toContain("管理员");

    unmuteChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    await handleUnmuteCommand(context({}));
    expect(lastReplyText()).toContain("再试");
  });
});
