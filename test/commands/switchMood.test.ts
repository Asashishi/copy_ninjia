import { beforeEach, describe, expect, mock, test } from "bun:test";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const switchAiMood = mock(async (_chatId: number): Promise<string> => "开心");
const loggerError = mock((..._args: unknown[]): void => {});
const states = new Map<number, Record<string, unknown>>();

// AI 闲聊的凭据；缺这一项 /switch_mood 会在读群状态之前就被拒（见 aiChat/availability.ts）。
mock.module("../../packages/infra/config", () => ({
  SUPER_ADMIN_USER_ID: 100,
  AI_CHAT_GEMINI_API_KEY: "test-gemini-key",
}));
mock.module("../../packages/config/whitelist", () => ({
  hasWhitelistPermission: (): boolean => false,
}));
mock.module("../../packages/infra/telegram", () => ({ sendMessage }));
mock.module("../../packages/aiChat", () => ({ switchAiMood }));
mock.module("../../packages/infra/logger", () => ({ logger: { error: loggerError } }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
}));

const { handleSwitchMoodCommand } = await import("../../packages/commands/switchMood");

function context(userId: number | undefined = 100): never {
  return {
    chat: { id: -1001 },
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 7,
  } as never;
}

beforeEach(() => {
  states.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(async (..._args: unknown[]): Promise<number | undefined> => 1);
  switchAiMood.mockClear();
  switchAiMood.mockImplementation(async (_chatId: number): Promise<string> => "开心");
  loggerError.mockClear();
});

describe("/switch_mood", () => {
  test("非超级管理员只被嘲讽，不触发重抽", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleSwitchMoodCommand(context(101));

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("轮不到杂鱼"),
      replyToMessageId: 7,
    });
  });

  test("本群未开 AI 闲聊时就地回复，不投递请求", async () => {
    await handleSwitchMoodCommand(context());

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没开"),
      replyToMessageId: 7,
    });
  });

  test("重抽成功后回复带回执的新心情名", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleSwitchMoodCommand(context());

    expect(switchAiMood).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("「开心」"),
      replyToMessageId: 7,
    });
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("Worker 不可用或回执超时时记录未确认错误并兜底回复", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    const failure = new Error("AI Worker is unavailable.");
    switchAiMood.mockImplementation(async (): Promise<string> => { throw failure; });

    await handleSwitchMoodCommand(context());

    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("Failed to confirm AI mood switch"), failure);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没确认到"),
      replyToMessageId: 7,
    });
  });

  test("重抽已确认但成功回复发送失败时不误报成重抽失败", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    const failure = new Error("Telegram unavailable.");
    sendMessage.mockImplementationOnce(async (): Promise<never> => { throw failure; });

    await expect(handleSwitchMoodCommand(context())).rejects.toBe(failure);

    expect(switchAiMood).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });
});
