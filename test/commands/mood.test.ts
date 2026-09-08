import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { TelegramConfig } from "../../packages/types/config";
import { MOOD_USAGE_TEXT } from "../../packages/consts/commandUsage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const queryAiMood = mock(async (_chatId: number): Promise<string> => "平静");
const switchAiMood = mock(async (_chatId: number): Promise<string> => "开心");
const loggerError = mock((..._args: unknown[]): void => {});
const states = new Map<number, Record<string, unknown>>();

mock.module("../../packages/config/telegram", () => ({
  SUPER_ADMIN_USER_ID: 100,
  getTelegramConfig: (): TelegramConfig => ({ botToken: "telegram-token", superAdminUserId: 100 }),
}));
// 超级管理员由身份直接持有全部白名单权限（见 packages/infra/identityPolicy/whitelist.ts 的
// getEffectiveWhitelistPermissions），命令层不再单独判身份。
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number): boolean => id === 100,
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/aiChat", () => ({ queryAiMood, switchAiMood }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
}));

const { handleMoodCommand } = await import("../../packages/commands/mood");

function context(argument: string, userId: number | undefined = 100): never {
  return {
    chat: { id: -1001 },
    from: userId === undefined ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 7,
    match: argument,
  } as never;
}

beforeEach(() => {
  states.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(async (..._args: unknown[]): Promise<number | undefined> => 1);
  queryAiMood.mockClear();
  queryAiMood.mockImplementation(async (_chatId: number): Promise<string> => "平静");
  switchAiMood.mockClear();
  switchAiMood.mockImplementation(async (_chatId: number): Promise<string> => "开心");
  loggerError.mockClear();
});

test.each(["", "unknown", "query extra", "switch extra", "query switch"])("/mood %s 不发起查询或重抽", async (argument) => {
  states.set(-1001, { isAIChatEnabled: true });
  await handleMoodCommand(context(argument));
  expect(queryAiMood).not.toHaveBeenCalled();
  expect(switchAiMood).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith({ chatId: -1001, text: MOOD_USAGE_TEXT, replyToMessageId: 7 });
});

describe("mood commands: /mood query", () => {
  test("普通群成员可查询当前心情，不经过 isCanSwitchMood 权限", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleMoodCommand(context("  query\n", 101));

    expect(queryAiMood).toHaveBeenCalledWith(-1001);
    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("「平静」"),
      replyToMessageId: 7,
    });
  });

  test("本群未开 AI 闲聊时不投递查询请求", async () => {
    await handleMoodCommand(context("query", 101));

    expect(queryAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没开"),
      replyToMessageId: 7,
    });
  });

  test("Worker 不可用或回执超时时记录错误并兜底回复", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    const failure = new Error("AI Worker is unavailable.");
    queryAiMood.mockImplementation(async (): Promise<string> => { throw failure; });

    await handleMoodCommand(context("query", 101));

    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("Failed to confirm AI mood query"), failure);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没查到"),
      replyToMessageId: 7,
    });
  });
});

describe("mood commands: /mood switch", () => {
  test("非超级管理员只被嘲讽，不触发重抽", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleMoodCommand(context("switch", 101));

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("轮不到杂鱼"),
      replyToMessageId: 7,
    });
  });

  test("本群未开 AI 闲聊时就地回复，不投递请求", async () => {
    await handleMoodCommand(context("switch"));

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没开"),
      replyToMessageId: 7,
    });
  });

  test("重抽成功后回复带回执的新心情名", async () => {
    states.set(-1001, { isAIChatEnabled: true });
    await handleMoodCommand(context("switch"));

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

    await handleMoodCommand(context("switch"));

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

    await expect(handleMoodCommand(context("switch"))).rejects.toBe(failure);

    expect(switchAiMood).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });
});
