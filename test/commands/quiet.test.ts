import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const states = new Map<number, Record<string, unknown>>();

mock.module("../../packages/infra/telegram", () => ({ sendMessage }));
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
  persistAuthoritativeState: async (...args: unknown[]): Promise<void> => { saveStateInBackground(...args); },
  saveStateInBackground,
}));

const { handleQuietCommand, handleUnquietCommand } = await import("../../packages/commands/quiet");
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
  test("默认时长、四舍五入和上下限都写成确定截止时间", async () => {
    await handleQuietCommand(context(""));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 3 * 60_000);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("quiet set");

    states.clear();
    await handleQuietCommand(context("99"));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 15 * 60_000);
    states.clear();
    await handleQuietCommand(context("1.6"));
    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 2 * 60_000);
  });

  test("非法参数和仍在静默期的重复调用不改状态", async () => {
    await handleQuietCommand(context("NaN"));
    expect(states.size).toBe(0);
    expect(saveStateInBackground).not.toHaveBeenCalled();

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

  test("墙钟回拨导致截止时间超过最大窗口时允许重建静默", async () => {
    states.set(-1001, { quietUntil: 1_000_000 + 16 * 60_000 });

    await handleQuietCommand(context("2"));

    expect(states.get(-1001)?.quietUntil).toBe(1_000_000 + 2 * 60_000);
    expect(saveStateInBackground).toHaveBeenCalledWith("quiet set");
  });
});
