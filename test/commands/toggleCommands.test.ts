const syncAtmosphere = mock((_chatId: number): void => {});
const postAntiRaid = mock((_message: unknown): boolean => true);
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({
  syncAntiRaidAtmosphere: syncAtmosphere,
  postAntiRaid,
}));
const syncMenu = mock(async (): Promise<void> => {});
mock.module("../../packages/app/commandMenu", () => ({ syncChatCommandMenu: syncMenu }));
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ANTI_RAID_DISABLE_TEARDOWN_FAILED_TEXT, INIT_CHAT_LIMIT_TEXT, INIT_TOGGLE_TEXTS } from "../../packages/consts/atmosphere/teasing/commands";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { botPermissions } from "../helpers/botPermissions";
import { lastReplyText } from "../helpers/replies";
import type { ChatState, LockdownRecord } from "../../packages/types/chatState";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const invalidateAiChat = mock((..._args: unknown[]): void => {});
const syncAiChatPersona = mock((_chatId: number): void => {});
mock.module("../../packages/aiChat/workerBridge", () => ({ syncAiChatPersona }));
const teardownChatRuntime = mock(async (_chatId: number, _reason: unknown): Promise<void> => {});
const invalidateBotAdminStatus = mock((chatId: number): void => {
  delete states.get(chatId)?.botPermissions;
});
const saveStateInBackground = mock((..._args: unknown[]): void => {});
const persistChatState = mock(async (_chatId: number, context: string): Promise<void> => { saveStateInBackground(context); });
const handleCopyCommand = mock(async (..._args: unknown[]): Promise<void> => {});
const clearAdDetection = mock((..._args: unknown[]): void => {});
const clearFloodControl = mock((..._args: unknown[]): void => {});
const deactivateJoinGuardChat = mock((..._args: unknown[]): void => {});
const { chatStateCache: states } = await import("../../packages/cache/main/chatState");
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");
const delegatedPermissions: Map<number, Set<string>> = new Map<number, Set<string>>();

mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  SUPER_ADMIN_USER_ID: 100,
}));
// 超级管理员由身份直接持有全部白名单权限（见 packages/infra/identityPolicy/whitelist.ts 的
// getEffectiveWhitelistPermissions），其余身份按逐项授权表决定。
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 100 || delegatedPermissions.get(id)?.has(key) === true,
}));
// 开关命令测试只验证授权与状态变化，配置校验一律视为通过；失败分支见 configGate.test.ts。
mock.module("../../packages/config/readiness", () => ({
  adDetectConfigReadiness: (): { ok: true } => ({ ok: true }),
  aiChatConfigReadiness: (): { ok: true } => ({ ok: true }),
  translateConfigReadiness: (): { ok: true } => ({ ok: true }),
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
}));
mock.module("../../packages/aiChat", () => ({ invalidateAiChat }));
mock.module("../../packages/antiRaid", () => ({ clearAdDetection, clearFloodControl, deactivateJoinGuardChat }));
// resolveBotAdminStatus 是 /init enable 之后重新判定管理员身份的调用点（见 infra/botAdmin.ts）。
const resolveBotAdminStatus = mock(async (_chatId: number): Promise<boolean> => false);
mock.module("../../packages/infra/botAdmin", () => ({ invalidateBotAdminStatus, resolveBotAdminStatus }));
mock.module("../../packages/infra/chatTeardown", () => ({ teardownChatRuntime }));
// 群状态走真实 stateStore 与 LRU（getOrCreateChatState / clearChatStateField /
// purgeChatStateExceptLockdown 的收敛语义不替身）；只替身它下面的 SQLite 落盘边界。
mock.module("../../packages/infra/chatStateStorage", () => ({
  assertChatStateCapacity: (): void => {},
  hydrateChatStateCache: (): void => {},
  persistChatState,
  saveChatStateInBackground: (): void => {},
}));
mock.module("../../packages/commands/copy", () => ({ handleCopyCommand }));

const { handleAdDetectCommand } = await import("../../packages/commands/adDetect");
const { handleAiChatCommand } = await import("../../packages/commands/aiChat");
const { handleInitCommand } = await import("../../packages/commands/init");
const { handleTranslateCommand } = await import("../../packages/commands/translate");
const { handleFloodControlCommand } = await import("../../packages/commands/floodControl");
const { handleAntiRaidCommand } = await import("../../packages/commands/antiRaid");
const { isSuperAdmin, resolveSuperAdminToggleArg } = await import("../../packages/commands/superAdminToggle");

function context(argument: string, userId: number | null = 100, chatId: number = -1001): never {
  const chat = { id: chatId, type: "supergroup" };
  return {
    chat,
    from: userId === null ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msg: { message_id: 7, chat },
    msgId: 7,
    match: argument,
  } as never;
}

beforeEach(() => {
  states.clear();
  chatIsSupergroupById.clear();
  postAntiRaid.mockClear();
  delegatedPermissions.clear();
  sendMessage.mockClear();
  invalidateAiChat.mockClear();
  syncAiChatPersona.mockReset();
  teardownChatRuntime.mockClear();
  // 模拟 Anti-Raid teardown 对群类型镜像的清理。
  teardownChatRuntime.mockImplementation(async (chatId: number): Promise<void> => {
    chatIsSupergroupById.delete(chatId);
  });
  invalidateBotAdminStatus.mockClear();
  resolveBotAdminStatus.mockClear();
  resolveBotAdminStatus.mockImplementation(async (_chatId: number): Promise<boolean> => false);
  saveStateInBackground.mockClear();
  persistChatState.mockClear();
  persistChatState.mockImplementation(async (_chatId: number, context: string): Promise<void> => {
    saveStateInBackground(context);
  });
  handleCopyCommand.mockClear();
  clearAdDetection.mockClear();
  clearFloodControl.mockClear();
  deactivateJoinGuardChat.mockClear();
  deactivateJoinGuardChat.mockImplementation((..._args: unknown[]): void => {});
});

describe("超级管理员开关命令", () => {
  test("权限与参数校验拒绝外部用户和未知参数", async () => {
    expect(isSuperAdmin(undefined)).toBe(false);
    expect(isSuperAdmin({ id: 101 } as never)).toBe(false);
    expect(isSuperAdmin({ id: 100 } as never)).toBe(true);

    const messages = {
      texts: {
        rejection: (label: string): string => `reject:${label}`,
        usage: "usage",
        enabled: "enabled",
        disabled: "disabled",
        alreadyEnabled: "alreadyEnabled",
        alreadyDisabled: "alreadyDisabled",
      },
      permission: "isCanControllAIPermission" as const,
    };
    await expect(resolveSuperAdminToggleArg(context("enable", 101), messages)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: "reject:@admin",
      replyToMessageId: 7,
    });
    await expect(resolveSuperAdminToggleArg(context("enable", null), messages)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: `reject:${ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unknownActor}`,
      replyToMessageId: 7,
    });
    // 省略 permission 时只认超级管理员本人：持有任何白名单权限都不放行。
    delegatedPermissions.set(200, new Set(["isCanControllAIPermission"]));
    await expect(resolveSuperAdminToggleArg(context("enable", 200), { texts: messages.texts }))
      .resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenLastCalledWith({ chatId: -1001, text: "reject:@admin", replyToMessageId: 7 });
    await expect(resolveSuperAdminToggleArg(context("enable", 100), { texts: messages.texts }))
      .resolves.toBe("enable");
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
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("/ad_detect enable/disable 写入统一状态，disable 同步清掉 Worker 待检队列", async () => {
    await handleAdDetectCommand(context("enable"));
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("ad_detect toggled");
    expect(clearAdDetection).not.toHaveBeenCalled();

    await handleAdDetectCommand(context("disable"));
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(false);
    // disable 同步清掉 Worker 里已排队的待检消息。
    expect(clearAdDetection).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("回归用例：Worker 不可用时 /ad_detect disable 不把异常抛出去——那会焊出一个重启循环", async () => {
    clearAdDetection.mockImplementationOnce((): never => {
      throw new Error("Anti-Raid Worker is unavailable.");
    });
    states.set(-1001, { isAdDetectEnabled: true });

    await handleAdDetectCommand(context("disable"));

    expect(states.get(-1001)?.isAdDetectEnabled).toBe(false);
    // 开关照样关掉，回执照样发出去。
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("/flood_control 缺省关闭，enable 持久化开启，disable 清空该群计数窗口", async () => {
    expect(states.get(-1001)?.isFloodControlEnabled).toBeUndefined();

    await handleFloodControlCommand(context("enable"));
    expect(states.get(-1001)?.isFloodControlEnabled).toBe(true);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("flood_control toggled");
    expect(clearFloodControl).not.toHaveBeenCalled();

    await handleFloodControlCommand(context("disable"));
    expect(states.get(-1001)?.isFloodControlEnabled).toBe(false);
    expect(clearFloodControl).toHaveBeenCalledWith(-1001);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("Worker 不可用时 /flood_control disable 仍完成关闭并发送回执", async () => {
    clearFloodControl.mockImplementationOnce((): never => {
      throw new Error("Anti-Raid Worker is unavailable.");
    });
    states.set(-1001, { isFloodControlEnabled: true });

    await handleFloodControlCommand(context("disable"));

    expect(states.get(-1001)?.isFloodControlEnabled).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledWith("flood_control toggled");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("/flood_control 仅允许超级管理员或获授对应 Controll 权限的白名单身份", async () => {
    await handleFloodControlCommand(context("enable", 201));
    expect(states.size).toBe(0);

    delegatedPermissions.set(200, new Set(["isCanControllFloodControlPermission"]));
    await handleFloodControlCommand(context("enable", 200));
    expect(states.get(-1001)?.isFloodControlEnabled).toBe(true);
  });

  test("/antiraid 缺省关闭，enable 持久化开启，disable 收掉这个群的入群守卫运行态", async () => {
    expect(states.get(-1001)?.isAntiRaidEnabled).toBeUndefined();

    await handleAntiRaidCommand(context("enable"));
    expect(states.get(-1001)?.isAntiRaidEnabled).toBe(true);
    expect(saveStateInBackground).toHaveBeenLastCalledWith("antiraid toggled");
    // enable 没有运行态要拆：窗口是入群时才开的。
    expect(deactivateJoinGuardChat).not.toHaveBeenCalled();

    await handleAntiRaidCommand(context("disable"));
    expect(states.get(-1001)?.isAntiRaidEnabled).toBe(false);
    // 只拆入群这条链路：广告检测与防刷屏各有各的开关，不能被这条命令一起关掉。
    expect(deactivateJoinGuardChat).toHaveBeenCalledWith(-1001);
    expect(clearAdDetection).not.toHaveBeenCalled();
    expect(clearFloodControl).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("Worker 不可用时 /antiraid disable 仍完成关闭，但回执如实说没拆干净", async () => {
    deactivateJoinGuardChat.mockImplementationOnce((): never => {
      throw new Error("Anti-Raid Worker is unavailable.");
    });
    states.set(-1001, { isAntiRaidEnabled: true });

    await handleAntiRaidCommand(context("disable"));

    // 开关照样 durable 地关掉，即使拆运行态抛错。
    expect(states.get(-1001)?.isAntiRaidEnabled).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledWith("antiraid toggled");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      text: ANTI_RAID_DISABLE_TEARDOWN_FAILED_TEXT,
    }));
  });

  test("/antiraid 仅允许超级管理员或获授 isCanControllAntiRaidPermission 的白名单身份", async () => {
    await handleAntiRaidCommand(context("enable", 201));
    expect(states.size).toBe(0);

    delegatedPermissions.set(200, new Set(["isCanControllAntiRaidPermission"]));
    await handleAntiRaidCommand(context("enable", 200));
    expect(states.get(-1001)?.isAntiRaidEnabled).toBe(true);
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
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: INIT_TOGGLE_TEXTS.rejection("@admin"),
      replyToMessageId: 7,
    });

    await handleAiChatCommand(context("enable", 200));
    expect(states.get(-1001)?.isAIChatEnabled).toBe(true);
  });

  test("State 已管理 25 个群时拒绝为第 26 个群启用 /init", async () => {
    for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
      states.set(-2_000 - index, { isInitEnabled: true });
    }

    await handleInitCommand(context("enable"));

    expect(states.has(-1001)).toBe(false);
    expect(persistChatState).not.toHaveBeenCalled();
    expect(resolveBotAdminStatus).not.toHaveBeenCalled();
    expect(chatIsSupergroupById.has(-1001)).toBeFalse();
    expect(postAntiRaid).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(INIT_CHAT_LIMIT_TEXT);
  });

  test("首次启用落盘后立即补齐群类型镜像", async () => {
    await handleInitCommand(context("enable"));

    expect(persistChatState).toHaveBeenCalledWith(-1001, "init toggled");
    expect(chatIsSupergroupById.get(-1001)).toBeTrue();
    expect(postAntiRaid).toHaveBeenCalledWith({ type: "chatKind", chatId: -1001, isSupergroup: true });
  });

  test("/init disable 连群名一起清掉：不再管的群不留任何记录", async () => {
    states.set(-1001, { isInitEnabled: true, title: "Test Group" });

    await handleInitCommand(context("disable"));

    expect(states.has(-1001)).toBe(false);
  });

  test("25 轮「启用又关掉」之后仍能为新群启用 /init——残留的 title 曾经会把群槽吃光", async () => {
    for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index += 1) {
      const chatId: number = -2_000 - index;
      await handleInitCommand(context("enable", 100, chatId));
      // 启用过的群基本都会记下群名（每条群消息顺手记一次，见 infra/chatTitle.ts）。
      states.get(chatId)!.title = `群 ${index}`;
      await handleInitCommand(context("disable", 100, chatId));
      expect(states.has(chatId)).toBe(false);
    }

    await handleInitCommand(context("enable"));

    expect(states.get(-1001)?.isInitEnabled).toBe(true);
    expect(lastReplyText(sendMessage)).not.toBe(INIT_CHAT_LIMIT_TEXT);
  });

  test("频道白名单按 sender_chat 取得委派权限", async () => {
    delegatedPermissions.set(-500, new Set(["isCanControllAdDetectPermission"]));
    const ctx = context("enable", 201) as unknown as {
      msg: { sender_chat: object };
    };
    ctx.msg = {
      ...ctx.msg,
      sender_chat: { id: -500, type: "channel", title: "Trusted Channel" },
    };

    await handleAdDetectCommand(ctx as never);

    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);
  });

  test("/init disable 同时失效 AI 并整行删除群状态，enable 恢复群更新入口", async () => {
    states.set(-1001, { botPermissions: botPermissions(), isAIChatEnabled: true });
    await handleInitCommand(context("disable"));
    // 整行没了：功能开关、权限快照与总开关一起删掉。
    expect(states.has(-1001)).toBeFalse();
    expect(invalidateBotAdminStatus).toHaveBeenLastCalledWith(-1001);
    expect(teardownChatRuntime).toHaveBeenCalledWith(-1001, "explicitDisable");

    await handleInitCommand(context("enable"));
    expect(states.get(-1001)?.isInitEnabled).toBe(true);
    expect(states.get(-1001)?.botPermissions).toBeUndefined();
    // 重新启用不恢复任何功能开关：那一行已经删掉了，要用哪个功能逐条重开。
    expect(states.get(-1001)?.isAIChatEnabled).toBeUndefined();
    expect(invalidateBotAdminStatus).toHaveBeenCalledTimes(2);
    // disable 写两次（总开关一次、拆完的整行删除一次），enable 一次。
    expect(saveStateInBackground).toHaveBeenCalledTimes(3);
    // enable 必须立刻重新判定管理员身份。
    expect(resolveBotAdminStatus).toHaveBeenCalledWith(-1001);
    // disable 不重判——那一刻合取本来就不成立。
    expect(resolveBotAdminStatus).toHaveBeenCalledTimes(1);
  });

  test("/init disable 保留仍未恢复的 lockdown，只删其余群配置", async () => {
    const lockdown: LockdownRecord = { phase: "active", intentId: 7, originalPermissions: {}, announced: true, expiresAt: 9_000 };
    states.set(-1001, { isInitEnabled: true, isAdDetectEnabled: true, lockdown });

    await handleInitCommand(context("disable"));

    expect(states.get(-1001)).toEqual({ lockdown });
  });

  test("/init disable 拆运行态失败仍持久化禁用状态，回执如实说没拆干净", async () => {
    const teardownError = new Error("chat teardown failed");
    states.set(-1001, {
      isInitEnabled: true,
      isAdDetectEnabled: true,
      botPermissions: botPermissions(),
    });
    teardownChatRuntime.mockRejectedValueOnce(teardownError);

    // 拆运行态失败不上抛。
    await handleInitCommand(context("disable"));

    // 总开关已经 durable 地关掉；整行删除排在 teardown 之后，这一轮没跑到，
    // 功能开关还留着。
    expect(states.get(-1001)?.isInitEnabled).toBeUndefined();
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);
    expect(states.get(-1001)?.botPermissions).toBeUndefined();
    expect(saveStateInBackground).toHaveBeenCalledWith("init toggled");
    expect(saveStateInBackground).not.toHaveBeenCalledWith("init teardown settled");
    expect(syncAiChatPersona).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toContain("没能拆干净");
  });

  test("/init disable 不为没有记录的群建条目，重复关掉不撞群数上限", async () => {
    await handleInitCommand(context("disable"));

    expect(states.has(-1001)).toBeFalse();
    expect(lastReplyText(sendMessage)).toBe(INIT_TOGGLE_TEXTS.alreadyDisabled);
  });

  test("/init disable 的总开关先落盘，再拆运行态", async () => {
    // teardownChatRuntime 里有不可逆的持久化动作（aiChat owner 的 durable 记忆
    // 删除、translate owner 的会话删除）；口径同 superAdminToggle.ts 的 runChatToggleCommand。
    const order: string[] = [];
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions(), aiPersona: "本群人设" });
    persistChatState.mockImplementation(async (_chatId: number, context: string): Promise<void> => {
      order.push(`persist:${context}`);
      saveStateInBackground(context);
    });
    teardownChatRuntime.mockImplementationOnce(async (): Promise<void> => {
      order.push("teardown");
    });
    syncAiChatPersona.mockImplementation((chatId: number): void => {
      expect(states.get(chatId)?.aiPersona).toBeUndefined();
      order.push("persona removed");
    });

    await handleInitCommand(context("disable"));

    // 整行删除与它那次落盘都排在 teardown 之后：删行本身也是不可逆的持久化动作。
    expect(order).toEqual([
      "persist:init toggled",
      "teardown",
      "persist:init teardown settled",
      "persona removed",
    ]);
  });

  test("拆完无条件补一次落盘，把整行删除与 teardown 清掉的 isProxySendEnabled 一起写下去", async () => {
    // teardownChatRuntime 同步清掉的持久字段只有 isProxySendEnabled，整行删除同样只动内存。
    const order: string[] = [];
    states.set(-1001, {
      isInitEnabled: true,
      isProxySendEnabled: true,
      botPermissions: botPermissions(),
    });
    persistChatState.mockImplementation(async (_chatId: number, context: string): Promise<void> => {
      order.push(`persist:${context}`);
      saveStateInBackground(context);
    });
    teardownChatRuntime.mockImplementationOnce(async (): Promise<void> => {
      order.push("teardown");
    });

    await handleInitCommand(context("disable"));

    expect(order).toEqual([
      "persist:init toggled",
      "teardown",
      "persist:init teardown settled",
    ]);
  });

  test("/init disable 落盘失败仍原样上抛，不确认这条 update", async () => {
    const persistError = new Error("state store quiesced");
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    persistChatState.mockRejectedValueOnce(persistError);

    await expect(handleInitCommand(context("disable"))).rejects.toBe(persistError);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("/translate 缺方向参数提示用法，开关参数只修改翻译状态", async () => {
    await handleTranslateCommand(context("@alice"));
    expect(handleCopyCommand).not.toHaveBeenCalled();

    await handleTranslateCommand(context("enable"));
    expect(states.get(-1001)?.isTranslationEnabled).toBe(true);
    await handleTranslateCommand(context("disable"));
    expect(states.get(-1001)?.isTranslationEnabled).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledTimes(2);
  });

  test("/ai_chat disable 在 state 与记忆删除都完成前不发送成功反馈", async () => {
    let releaseState!: () => void;
    let releaseDelete!: () => void;
    persistChatState.mockImplementationOnce(async (_chatId: number, context: string): Promise<void> => {
      saveStateInBackground(context);
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
    expect(invalidateAiChat).toHaveBeenCalledWith(-1001);
    expect(sendMessage).not.toHaveBeenCalled();

    releaseDelete();
    await command;
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

/** 每条开关命令的驱动方式与它写的那个 ChatState 字段。 */
interface ToggleCase {
  readonly name: string;
  readonly field: keyof ChatState;
  readonly run: (argument: string) => Promise<void>;
  /**
   * disable 之后该字段读出来是什么。功能开关落成 false（规范化后等价于「没设过」，
   * 但记录本身还在）；`/init` 的 disable 会整行删掉这个群，因此读出来是 undefined。
   * 逐条写死而不给默认值：`undefined` 在这里是一个有意义的期望，不是「没配」。
   */
  readonly disabledValue: boolean | undefined;
}

const TOGGLE_CASES: readonly ToggleCase[] = [
  {
    name: "/ai_chat",
    field: "isAIChatEnabled",
    run: (argument: string): Promise<void> => handleAiChatCommand(context(argument)),
    disabledValue: false,
  },
  {
    name: "/ad_detect",
    field: "isAdDetectEnabled",
    run: (argument: string): Promise<void> => handleAdDetectCommand(context(argument)),
    disabledValue: false,
  },
  {
    name: "/flood_control",
    field: "isFloodControlEnabled",
    run: (argument: string): Promise<void> => handleFloodControlCommand(context(argument)),
    disabledValue: false,
  },
  {
    name: "/translate",
    field: "isTranslationEnabled",
    run: (argument: string): Promise<void> => handleTranslateCommand(context(argument)),
    disabledValue: false,
  },
  {
    name: "/init",
    field: "isInitEnabled",
    run: (argument: string): Promise<void> => handleInitCommand(context(argument)),
    disabledValue: undefined,
  },
];

describe("开关命令的同状态重复执行", () => {
  for (const toggle of TOGGLE_CASES) {
    test(`${toggle.name} 同状态重复执行说破「本来就是」，不复用刚改完那句`, async () => {
      for (const action of ["enable", "disable"] as const) {
        const target: boolean | undefined = action === "enable" ? true : toggle.disabledValue;
        states.clear();
        // 先把状态推到相反一侧，保证紧接着那一次调用一定是真实变化。
        if (action === "disable") await toggle.run("enable");
        sendMessage.mockClear();

        await toggle.run(action);
        const changedText: string = lastReplyText(sendMessage);
        expect(states.get(-1001)?.[toggle.field]).toBe(target);

        await toggle.run(action);
        const repeatText: string = lastReplyText(sendMessage);
        // 状态不动，但回执必须换一句，不能沿用刚改完那句。
        expect(states.get(-1001)?.[toggle.field]).toBe(target);
        expect(repeatText).not.toBe(changedText);
        expect(repeatText).toContain("本来就");
      }
    });
  }

  test("同状态重复 disable 仍落盘并重跑运行时清理：上一次 Worker 不可用时就靠它补做", async () => {
    clearAdDetection.mockImplementationOnce((): never => {
      throw new Error("Anti-Raid Worker is unavailable.");
    });
    states.set(-1001, { isAdDetectEnabled: true });

    await handleAdDetectCommand(context("disable"));
    expect(clearAdDetection).toHaveBeenCalledTimes(1);
    saveStateInBackground.mockClear();

    await handleAdDetectCommand(context("disable"));
    expect(clearAdDetection).toHaveBeenCalledTimes(2);
    expect(saveStateInBackground).toHaveBeenCalledWith("ad_detect toggled");
    expect(lastReplyText(sendMessage)).toContain("本来就");
  });

  test("/init 重复 enable 仍不作废管理员记录，只是回执说破没变", async () => {
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });

    await handleInitCommand(context("enable"));

    expect(invalidateBotAdminStatus).not.toHaveBeenCalled();
    expect(resolveBotAdminStatus).not.toHaveBeenCalled();
    expect((states.get(-1001)?.botPermissions as { isAdministrator?: boolean } | undefined)?.isAdministrator).toBe(true);
    expect(states.get(-1001)?.isInitEnabled).toBe(true);
    expect(lastReplyText(sendMessage)).toContain("本来就");
  });
});
