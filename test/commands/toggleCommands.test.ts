import { beforeEach, describe, expect, mock, test } from "bun:test";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const invalidateAiChat = mock((..._args: unknown[]): void => {});
const teardownChatRuntime = mock(async (..._args: unknown[]): Promise<void> => {});
const invalidateBotAdminStatus = mock((chatId: number): void => {
  delete states.get(chatId)?.botIsAdmin;
});
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const persistAuthoritativeState = mock(async (...args: unknown[]): Promise<void> => { saveStateInBackground(...args); });
const handleCopyCommand = mock(async (..._args: unknown[]): Promise<void> => {});
const clearAdDetection = mock((..._args: unknown[]): void => {});
const states = new Map<number, Record<string, unknown>>();

mock.module("../../packages/infra/config", () => ({
  SUPER_ADMIN_USER_ID: 100,
  PRIVILEGED_USERS_ID: [],
  // 广告检测的凭据；缺这一项 /ad_detect enable 会被拒（见 commands/adDetect.ts）。
  DEEPSEEK_API_KEY: "test-deepseek-key",
}));
mock.module("../../packages/infra/telegram", () => ({ sendMessage }));
mock.module("../../packages/aiChat", () => ({ invalidateAiChat }));
mock.module("../../packages/antiRaid", () => ({ clearAdDetection }));
// /init enable 之后会重新判定一次管理员身份，好让「是管理员 && 已初始化」
// 那道边沿触发黑名单清扫（见 infra/botAdmin.ts）。
const isBotAdminIn = mock(async (_chatId: number): Promise<boolean> => false);
mock.module("../../packages/infra/botAdmin", () => ({ invalidateBotAdminStatus, isBotAdminIn, teardownChatRuntime }));
mock.module("../../packages/infra/storage/stateStore", () => ({
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
mock.module("../../packages/commands/copy", () => ({ handleCopyCommand }));

const { handleAdDetectCommand } = await import("../../packages/commands/adDetect");
const { handleAiChatCommand } = await import("../../packages/commands/aiChat");
const { handleInitCommand } = await import("../../packages/commands/init");
const { handleJaCopyCommand } = await import("../../packages/commands/jaCopy");
const { isSuperAdmin, resolveSuperAdminToggleArg } = await import("../../packages/commands/superAdminToggle");

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
  invalidateBotAdminStatus.mockClear();
  saveStateInBackground.mockClear();
  persistAuthoritativeState.mockClear();
  persistAuthoritativeState.mockImplementation(async (...args: unknown[]): Promise<void> => {
    saveStateInBackground(...args);
  });
  handleCopyCommand.mockClear();
  clearAdDetection.mockClear();
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

  test("/ad_detect enable/disable 写入统一状态，disable 同步清掉 Worker 待检队列", async () => {
    await handleAdDetectCommand(context("enable"));
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("ad_detect toggled");
    expect(clearAdDetection).not.toHaveBeenCalled();

    await handleAdDetectCommand(context("disable"));
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(false);
    // 主线程这道门禁只拦得住之后的消息；不清队列的话，关掉开关之后还会有人
    // 被排在 Worker 里的旧消息串判成广告拉黑。
    expect(clearAdDetection).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("/ad_detect 拒绝非超级管理员，不改任何状态", async () => {
    await handleAdDetectCommand(context("enable", 101));
    expect(states.size).toBe(0);
    expect(clearAdDetection).not.toHaveBeenCalled();
  });

  test("/init disable 同时失效 AI，enable 恢复群更新入口", async () => {
    states.set(-1001, { botIsAdmin: true });
    await handleInitCommand(context("disable"));
    expect(states.get(-1001)?.isInitEnabled).toBe(false);
    expect(states.get(-1001)?.botIsAdmin).toBeUndefined();
    expect(invalidateBotAdminStatus).toHaveBeenLastCalledWith(-1001);
    expect(teardownChatRuntime).toHaveBeenCalledWith(-1001);

    states.get(-1001)!.botIsAdmin = false;
    await handleInitCommand(context("enable"));
    expect(states.get(-1001)?.isInitEnabled).toBe(true);
    expect(states.get(-1001)?.botIsAdmin).toBeUndefined();
    expect(invalidateBotAdminStatus).toHaveBeenCalledTimes(2);
    expect(saveStateInBackground).toHaveBeenCalledTimes(2);
    // enable 必须立刻重新判定管理员身份：作废之后不重判，「是管理员 && 已初始化」
    // 那道边沿就永远等不到，「先给管理员、后 /init enable」的群不会被补扫黑名单。
    expect(isBotAdminIn).toHaveBeenCalledWith(-1001);
    // disable 不重判——那一刻合取本来就不成立。
    expect(isBotAdminIn).toHaveBeenCalledTimes(1);
  });

  test("/init disable 拆运行态失败仍持久化禁用状态，但不发送成功提示", async () => {
    const teardownError = new Error("chat teardown failed");
    states.set(-1001, { botIsAdmin: true });
    teardownChatRuntime.mockRejectedValueOnce(teardownError);

    await expect(handleInitCommand(context("disable"))).rejects.toBe(teardownError);

    expect(states.get(-1001)?.isInitEnabled).toBe(false);
    expect(states.get(-1001)?.botIsAdmin).toBeUndefined();
    expect(saveStateInBackground).toHaveBeenCalledWith("init toggled");
    expect(sendMessage).not.toHaveBeenCalled();
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
