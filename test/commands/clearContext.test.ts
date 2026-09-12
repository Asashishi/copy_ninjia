import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { TelegramConfig } from "../../packages/types/config";
import { CLEAR_CONTEXT_USAGE_TEXT } from "../../packages/consts/commandUsage";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const invalidateAiChat = mock(async (_chatId: number, _purgeMemory: boolean): Promise<void> => undefined);
const loggerError = mock((..._args: unknown[]): void => {});
const delegatedPermissions = new Set<number>();

mock.module("../../packages/config/telegram", () => ({
  SUPER_ADMIN_USER_ID: 100,
  getTelegramConfig: (): TelegramConfig => ({ botToken: "telegram-token", superAdminUserId: 100 }),
}));
// 白名单权限照常可授予，但这条命令根本不查权限键（只认 SUPER_ADMIN_USER_ID 身份），
// 授权了也一样进不来——下面那条用例钉的就是这件事。
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 100 || (key === "isCanControllAIPermission" && delegatedPermissions.has(id)),
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

    // purgeMemory=true 才同时走 Worker 侧 purge 与 durable 删除 memory/ai/<chatId>.json。
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("一句都不记得"),
      replyToMessageId: 7,
    });
  });

  test("白名单身份即使拿到 isCanControllAIPermission 也清不了：这条命令只认超级管理员", async () => {
    delegatedPermissions.add(200);
    await handleClearContextCommand(context("", 200));

    expect(invalidateAiChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("哪来的资格"),
      replyToMessageId: 7,
    });
  });

  test("普通群成员只被嘲讽，不清任何记忆", async () => {
    await handleClearContextCommand(context("", 201));

    expect(invalidateAiChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("哪来的资格"),
      replyToMessageId: 7,
    });
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
    await handleClearContextCommand(context(argument));

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
