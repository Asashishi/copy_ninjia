import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { TelegramConfig } from "../../packages/types/config";
import { CLEAR_CONTEXT_USAGE_TEXT } from "../../packages/consts/atmosphere/teasing/commandUsage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const invalidateAiChat = mock(async (_chatId: number, _purgeMemory: boolean): Promise<void> => undefined);
const loggerError = mock((..._args: unknown[]): void => {});
const delegatedPermissions = new Set<number>();

mock.module("../../packages/config/telegram", () => ({
  SUPER_ADMIN_USER_ID: 100,
  getTelegramConfig: (): TelegramConfig => ({ botToken: "telegram-token", superAdminUserId: 100 }),
}));
// 超级管理员直授全部权限，普通成员按被授予的独立权限位判定。
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 100 || (key === "isCanClearContext" && delegatedPermissions.has(id)) ||
    (key === "isCanControllAIPermission" && id === 201),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/aiChat", () => ({ invalidateAiChat }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { handleClearContextCommand } = await import("../../packages/commands/clearContext");

// userId 传 null 表示这条 update 解析不出发起身份；显式 undefined 会被默认值
// 补成超级管理员，那正好把「拒绝」测成「放行」。
function context(argument: string = "", userId: number | null = 100): never {
  return {
    chat: { id: -1001 },
    from: userId === null ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msgId: 7,
    match: argument,
  } as never;
}

beforeEach(() => {
  delegatedPermissions.clear();
  sendMessage.mockClear();
  invalidateAiChat.mockClear();
  invalidateAiChat.mockImplementation(async (_chatId: number, _purgeMemory: boolean): Promise<void> => undefined);
  loggerError.mockClear();
});

describe("/clear_context", () => {
  test("超级管理员清空本群上下文：内存与磁盘记忆一并删除", async () => {
    await handleClearContextCommand(context("", 100));

    // purgeMemory=true 才同时走 Worker 侧 purge 与 durable 删除 chat_states.ai_context。
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("一句都不记得"),
      replyToMessageId: 7,
    });
  });

  test("持有 isCanClearContext 的白名单成员可以清理当前群", async () => {
    delegatedPermissions.add(200);
    await handleClearContextCommand(context("", 200));
    expect(invalidateAiChat).toHaveBeenCalledTimes(1);
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);

    delegatedPermissions.delete(200);
    invalidateAiChat.mockClear();
    await handleClearContextCommand(context("", 200));
    expect(invalidateAiChat).not.toHaveBeenCalled();
  });

  test.each([201, 202])("只有 AI 开关权限或未授权的成员 %i 不清任何记忆", async (id) => {
    await handleClearContextCommand(context("", id));

    expect(invalidateAiChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("哪来的资格"),
      replyToMessageId: 7,
    });
  });

  test("sender_chat 按可见频道身份授权，不借用 from 的超管权限", async () => {
    const ctx = {
      chat: { id: -1001, type: "supergroup" },
      msg: { sender_chat: { id: -2001, type: "channel", title: "频道" } },
      from: { id: 100, first_name: "Admin" },
      msgId: 7,
      match: "",
    };
    await handleClearContextCommand(ctx as never);
    expect(invalidateAiChat).not.toHaveBeenCalled();
    delegatedPermissions.add(-2001);
    await handleClearContextCommand(ctx as never);
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);
  });

  test("解析不出发起身份时同样拒绝", async () => {
    await handleClearContextCommand(context("", null));

    expect(invalidateAiChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("哪个杂鱼"),
      replyToMessageId: 7,
    });
  });

  test.each(["enable", "all", "-1001"])("带参数 %s 只回用法提示，不清记忆", async (argument) => {
    delegatedPermissions.add(200);
    await handleClearContextCommand(context(argument, 200));

    expect(invalidateAiChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: CLEAR_CONTEXT_USAGE_TEXT,
      replyToMessageId: 7,
    });
  });

  test("清理失败只回一句并记日志，异常不外抛拖垮这条 update", async () => {
    const failure = new Error("worker unavailable");
    invalidateAiChat.mockImplementation(async (): Promise<void> => {
      throw failure;
    });

    await expect(handleClearContextCommand(context())).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      "Failed to clear the AI chat context of chat -1001:",
      failure
    );
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("没擦干净"),
      replyToMessageId: 7,
    });
  });
});
