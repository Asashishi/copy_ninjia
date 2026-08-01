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
const delegatedPermissions: Map<number, Set<string>> = new Map<number, Set<string>>();

mock.module("../../packages/infra/config", () => ({
  SUPER_ADMIN_USER_ID: 100,
  // AI 闲聊的凭据；缺这一项 /ai_chat enable 会被拒（见 aiChat/availability.ts）。
  AI_CHAT_GEMINI_API_KEY: "test-gemini-key",
  // 广告检测的凭据；缺这一项 /ad_detect enable 会被拒（见 commands/adDetect.ts）。
  AD_DETECT_DEEPSEEK_API_KEY: "test-deepseek-key",
}));
mock.module("../../packages/config/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    delegatedPermissions.get(id)?.has(key) === true,
}));
// 开关命令测试只验证授权与状态变化；部署文件的失败分支由 configGate 与
// featurePreflight 专门覆盖，不能让本机 g-auth.json 是否存在左右这里的结果。
mock.module("../../packages/config/readiness", () => ({
  adDetectConfigReadiness: (): { ok: true } => ({ ok: true }),
  aiChatConfigReadiness: (): { ok: true } => ({ ok: true }),
  jaTranslateConfigReadiness: (): { ok: true } => ({ ok: true }),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/aiChat", () => ({ invalidateAiChat }));
mock.module("../../packages/antiRaid", () => ({ clearAdDetection }));
// /init enable 之后会重新判定一次管理员身份，好让「是管理员 && 已初始化」
// 那道边沿触发黑名单清扫（见 infra/botAdmin.ts）。
const resolveBotAdminStatus = mock(async (_chatId: number): Promise<boolean> => false);
mock.module("../../packages/infra/botAdmin", () => ({ invalidateBotAdminStatus, resolveBotAdminStatus, teardownChatRuntime }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getOrCreateChatState(chatId: number): Record<string, unknown> {
    let state = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  // aiChat/availability.ts 的按群判定要读它；这里的命令只关心开关本身，
  // 读到空对象即可（等价于「本群还没开过」）。
  getChatState(chatId: number): Record<string, unknown> {
    return states.get(chatId) ?? {};
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
  delegatedPermissions.clear();
  sendMessage.mockClear();
  invalidateAiChat.mockClear();
  teardownChatRuntime.mockClear();
  invalidateBotAdminStatus.mockClear();
  resolveBotAdminStatus.mockClear();
  resolveBotAdminStatus.mockImplementation(async (_chatId: number): Promise<boolean> => false);
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

    const messages = {
      rejection: (label: string): string => `reject:${label}`,
      usage: "usage",
      permission: "isCanControllAIPermission" as const,
    };
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

  test("回归用例：Worker 不可用时 /ad_detect disable 不把异常抛出去——那会焊出一个重启循环", async () => {
    // post() 只在「Worker 用尽重启预算被放弃」与「正在重生」两种状态下失败，而
    // 那两种状态下待检队列本来就随旧 isolate 一起没了，没有任何东西需要清。放异常
    // 逃出 handler 的代价是：开关已经落盘，这条 update 却被判失败，最终 offset 扣住
    // 不确认、进程非零退出，重启后 Telegram 重投同一条命令——Worker 仍不可用。
    clearAdDetection.mockImplementationOnce((): never => {
      throw new Error("Anti-Raid Worker is unavailable.");
    });
    states.set(-1001, { isAdDetectEnabled: true });

    await handleAdDetectCommand(context("disable"));

    expect(states.get(-1001)?.isAdDetectEnabled).toBe(false);
    // 开关照样关掉，回执照样发出去。
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("/ad_detect 拒绝非超级管理员，不改任何状态", async () => {
    await handleAdDetectCommand(context("enable", 101));
    expect(states.size).toBe(0);
    expect(clearAdDetection).not.toHaveBeenCalled();
  });

  test("白名单身份可控制获授的普通开关，但 /init 始终由超级管理员独占", async () => {
    delegatedPermissions.set(200, new Set(["isCanControllAIPermission"]));

    await handleInitCommand(context("enable", 200));
    expect(states.get(-1001)?.isInitEnabled).toBeUndefined();

    await handleAiChatCommand(context("enable", 200));
    expect(states.get(-1001)?.isAIChatEnabled).toBe(true);
  });

  test("频道白名单按 sender_chat 取得委派权限", async () => {
    delegatedPermissions.set(-500, new Set(["isCanControllAdDetectPermission"]));
    const ctx = context("enable", 201) as unknown as {
      msg: { sender_chat: object };
    };
    ctx.msg = {
      sender_chat: { id: -500, type: "channel", title: "Trusted Channel" },
    };

    await handleAdDetectCommand(ctx as never);

    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);
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
    expect(resolveBotAdminStatus).toHaveBeenCalledWith(-1001);
    // disable 不重判——那一刻合取本来就不成立。
    expect(resolveBotAdminStatus).toHaveBeenCalledTimes(1);
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
