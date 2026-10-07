import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const states = new Map<number, Record<string, unknown>>();

mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  getOrCreateChatState(chatId: number): Record<string, unknown> {
    let state = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  clearChatStateField(chatId: number, field: string): boolean {
    const state = states.get(chatId);
    if (!state || !(field in state)) return false;
    delete state[field];
    if (Object.keys(state).length === 0) states.delete(chatId);
    return true;
  },
  persistChatState: async (_chatId: number, context: string): Promise<void> => { saveStateInBackground(context); },
}));

const { handleQuietCommand, handleUnquietCommand } = await import("../../packages/commands/quiet");
const {
  DURATION_UNIT_MS,
  QUIET_DEFAULT_MINUTES,
  QUIET_MAX_MINUTES,
  QUIET_MIN_MINUTES,
} = await import("../../packages/consts/commands");
const { ATMOSPHERE_TEXTS } = await import("../../packages/consts/atmosphere");
const originalDateNow: () => number = Date.now;

function context(argument: string): never {
  return { chat: { id: -1001 }, msgId: 8, match: argument } as never;
}

beforeEach(() => {
  states.clear();
  sendMessage.mockClear();
  saveStateInBackground.mockClear();
  Date.now = (): number => 1_000_000;
});

afterEach(() => {
  Date.now = originalDateNow;
});

describe("/quiet 与 /unquiet", () => {
  test("默认时长、十进制整数和上下限都写成确定截止时间", async () => {
    await handleQuietCommand(context(""));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + QUIET_DEFAULT_MINUTES * DURATION_UNIT_MS.m);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("quiet set");

    states.clear();
    await handleQuietCommand(context(String(QUIET_MAX_MINUTES + 1)));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + QUIET_MAX_MINUTES * DURATION_UNIT_MS.m);
    states.clear();
    await handleQuietCommand(context("0"));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + QUIET_MIN_MINUTES * DURATION_UNIT_MS.m);
    states.clear();
    await handleQuietCommand(context("05"));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 5 * DURATION_UNIT_MS.m);
  });

  test.each(["NaN", "1.6", "0x5", "1e1", "-3", "+5", "５", "Infinity"])("非十进制整数参数 %s 回用法提示，不改状态", async (argument: string) => {
    await handleQuietCommand(context(argument));
    expect(states.size).toBe(0);
    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.quietUsage(QUIET_MIN_MINUTES, QUIET_MAX_MINUTES, QUIET_DEFAULT_MINUTES),
      replyToMessageId: 8,
    });
  });

  test("仍在静默期的重复调用不改状态", async () => {
    states.set(-1001, { quietUntil: 1_000_000 + 90_000 });
    await handleQuietCommand(context("10"));
    expect(states.get(-1001)?.quietUntil).toBe(1_090_000);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("还剩约 2 分钟"),
      replyToMessageId: 8,
    });
  });

  test("解除只处理仍生效的静默，并回收空状态", async () => {
    await handleUnquietCommand(context(""));
    expect(saveStateInBackground).not.toHaveBeenCalled();

    states.set(-1001, { quietUntil: 1_100_000 });
    await handleUnquietCommand(context(""));
    expect(states.has(-1001)).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledWith("quiet cleared");
  });

  test("小幅回拨落在容差内时静默仍然生效，不允许叠加重设", async () => {
    // isQuietUntilActive 的判定边界：静默上限加一段容差内都算生效中。
    states.set(-1001, { quietUntil: 1_000_000 + 16 * 60_000 });

    await handleQuietCommand(context("2"));

    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 16 * 60_000);
    expect(saveStateInBackground).not.toHaveBeenCalled();
  });

  test("回拨幅度超过容差时允许重建静默", async () => {
    states.set(-1001, { quietUntil: 1_000_000 + 20 * 60_000 });

    await handleQuietCommand(context("2"));

    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 2 * 60_000);
    expect(saveStateInBackground).toHaveBeenCalledWith("quiet set");
  });
});
