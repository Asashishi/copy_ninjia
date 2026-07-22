import { beforeEach, describe, expect, mock, test } from "bun:test";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const invalidateAiChat = mock((..._args: unknown[]): void => {});
const teardownChatRuntime = mock((..._args: unknown[]): void => {});
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const persistAuthoritativeState = mock(async (...args: unknown[]): Promise<void> => { saveStateInBackground(...args); });
const handleCopyCommand = mock(async (..._args: unknown[]): Promise<void> => {});
const states = new Map<number, Record<string, unknown>>();

mock.module("../../src/infra/config", () => ({ SUPER_ADMIN_USER_ID: 100, PRIVILEGED_USERS_ID: [] }));
mock.module("../../src/infra/telegram", () => ({ sendMessage }));
mock.module("../../src/aiChat", () => ({ invalidateAiChat }));
mock.module("../../src/infra/botAdmin", () => ({ teardownChatRuntime }));
mock.module("../../src/infra/storage/stateStore", () => ({
  getOrCreateChatState(chatId: number): Record<string, unknown> {
    let state = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  persistAuthoritativeState,
  saveStateInBackground,
}));
mock.module("../../src/commands/copy", () => ({ handleCopyCommand }));

const { handleAiChatCommand } = await import("../../src/commands/aiChat");
const { handleInitCommand } = await import("../../src/commands/init");
const { handleJaCopyCommand } = await import("../../src/commands/jaCopy");
const { isSuperAdmin, resolveSuperAdminToggleArg } = await import("../../src/commands/superAdminToggle");

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
  invalidateAiChat.mockClear();
  teardownChatRuntime.mockClear();
  saveStateInBackground.mockClear();
  persistAuthoritativeState.mockClear();
  persistAuthoritativeState.mockImplementation(async (...args: unknown[]): Promise<void> => {
    saveStateInBackground(...args);
  });
  handleCopyCommand.mockClear();
});

describe("超级管理员开关命令", () => {
  test("权限与参数校验拒绝外部用户和未知参数", async () => {
    expect(isSuperAdmin(undefined)).toBe(false);
    expect(isSuperAdmin({ id: 101 } as never)).toBe(false);
    expect(isSuperAdmin({ id: 100 } as never)).toBe(true);

    const messages = { rejection: (label: string): string => `reject:${label}`, usage: "usage" };
    await expect(resolveSuperAdminToggleArg(context("enable", 101), messages)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("reject:"),
      replyToMessageId: 7,
    });
    await expect(resolveSuperAdminToggleArg(context("invalid"), messages)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenLastCalledWith({ chatId: -1001, text: "usage", replyToMessageId: 7 });
    expect(states.size).toBe(0);
  });

  test("/ai_chat enable/disable 写入统一状态，disable 同步失效在途回复", async () => {
    await handleAiChatCommand(context(" ENABLE "));
    expect(states.get(-1001)?.isAIChatEnabled).toBe(true);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("ai_chat toggled");
    expect(invalidateAiChat).not.toHaveBeenCalled();

    await handleAiChatCommand(context("disable"));
    expect(states.get(-1001)?.isAIChatEnabled).toBe(false);
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("/init disable 同时失效 AI，enable 恢复群更新入口", async () => {
    await handleInitCommand(context("disable"));
    expect(states.get(-1001)?.isInitEnabled).toBe(false);
    expect(teardownChatRuntime).toHaveBeenCalledWith(-1001);

    await handleInitCommand(context("enable"));
    expect(states.get(-1001)?.isInitEnabled).toBe(true);
    expect(saveStateInBackground).toHaveBeenCalledTimes(2);
  });

  test("/ja_copy 非开关参数交给复制命令，开关参数只修改日语状态", async () => {
    const targetContext = context("@alice");
    await handleJaCopyCommand(targetContext);
    expect(handleCopyCommand).toHaveBeenCalledWith(targetContext, "ja");

    await handleJaCopyCommand(context("enable"));
    expect(states.get(-1001)?.isJATranslationEnabled).toBe(true);
    await handleJaCopyCommand(context("disable"));
    expect(states.get(-1001)?.isJATranslationEnabled).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledTimes(2);
  });

  test("/ai_chat disable 在 state 与记忆删除都完成前不发送成功反馈", async () => {
    let releaseState!: () => void;
    let releaseDelete!: () => void;
    persistAuthoritativeState.mockImplementationOnce(async (...args: unknown[]): Promise<void> => {
      saveStateInBackground(...args);
      await new Promise<void>((resolve) => { releaseState = resolve; });
    });
    invalidateAiChat.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseDelete = resolve; });
    });

    const command = handleAiChatCommand(context("disable"));
    await Bun.sleep(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(invalidateAiChat).not.toHaveBeenCalled();

    releaseState();
    await Bun.sleep(0);
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001, true);
    expect(sendMessage).not.toHaveBeenCalled();

    releaseDelete();
    await command;
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
