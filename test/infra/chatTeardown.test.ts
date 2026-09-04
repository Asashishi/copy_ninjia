import { beforeEach, describe, expect, mock, test } from "bun:test";
import { botPermissions } from "../helpers/botPermissions";

const calls: string[] = [];
const states = new Map<number, Record<string, unknown>>();
const saveStateInBackground = mock((context: string): void => { calls.push(`save:${context}`); });
const getChatMember = mock(async (): Promise<{ status: string }> => ({ status: "administrator" }));

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: { botInfo: { id: 99 }, api: { getChatMember } },
}));
mock.module("../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  telegramApi: { kind: "guard-api" },
}));
// botAdmin -> blocklist 的新晋管理员清扫会取这三个；本文件不触发（名单为空）。
mock.module("../../packages/infra/telegram/actions", () => ({
  isChatMember: async (): Promise<boolean> => false,
  banChatMember: async (): Promise<boolean> => true,
  banChatSenderChat: async (): Promise<boolean> => true,
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): ReadonlyMap<number, Record<string, unknown>> => states,
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number): Record<string, unknown> => {
    let state = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  clearChatStateField: (chatId: number, field: string): boolean => {
    calls.push(`clear:${field}`);
    const state = states.get(chatId);
    if (!state || !(field in state)) return false;
    delete state[field];
    return true;
  },
  pruneDepartedChatState: (chatId: number): void => {
    calls.push(`prune:${chatId}`);
    const lockdown = states.get(chatId)?.lockdown;
    if (lockdown === undefined) states.delete(chatId);
    else states.set(chatId, { lockdown });
  },
  persistChatState: async (_chatId: number, context: string): Promise<void> => { saveStateInBackground(context); },
  // 丢掉一份已知权限快照时 botAdmin 会顺手排一次后台写（内存清了、磁盘也得清）；
  // 这里只需要它存在，落盘断言在 botAdminPermissions.test.ts。
  saveChatStateInBackground: (_chatId: number, context: string): void => { saveStateInBackground(context); },
}));

const botAdmin = await import("../../packages/infra/botAdmin");
const botAdminCache = await import("../../packages/cache/main/botAdmin");
const chatTeardown = await import("../../packages/infra/chatTeardown");
const chatTeardownRegistry = await import("../../packages/infra/chatTeardownRegistry");
const { CHAT_TEARDOWN_ORDER } = await import("../../packages/consts/chatTeardown");

function memberContext(newStatus: string, oldStatus: string = "administrator"): never {
  return {
    myChatMember: {
      chat: { id: -1001, type: "supergroup" },
      old_chat_member: { status: oldStatus },
      new_chat_member: { status: newStatus },
    },
  } as never;
}

beforeEach(() => {
  calls.length = 0;
  states.clear();
  saveStateInBackground.mockClear();
  getChatMember.mockClear();
  getChatMember.mockImplementation(async (): Promise<{ status: string }> => ({ status: "administrator" }));
  botAdminCache.botPermissionFetches.clear();
  botAdminCache.botPermissionRequestTokens.clear();
  chatTeardownRegistry.registerChatTeardown("copy", (chatId: number): void => { calls.push(`copy:${chatId}`); });
  chatTeardownRegistry.registerChatTeardown("gag", (chatId: number): void => { calls.push(`gag:${chatId}`); });
  chatTeardownRegistry.registerChatTeardown("qa", (chatId: number): void => { calls.push(`qa:${chatId}`); });
  chatTeardownRegistry.registerChatTeardown("aiChat", (chatId: number): void => { calls.push(`ai:${chatId}:true`); });
  chatTeardownRegistry.registerChatTeardown("antiRaid", (chatId: number): void => { calls.push(`anti:${chatId}`); });
});

describe("chat runtime teardown", () => {
  // 从穷尽顺序表生成期望；新增 owner 时，顺序表与运行时派发必须同时覆盖。
  test("ChatRuntimeOwner 的每个 owner 都被组合 teardown 派发到", async () => {
    const dispatched: string[] = [];
    for (const owner of CHAT_TEARDOWN_ORDER) {
      chatTeardownRegistry.registerChatTeardown(owner, (): void => { dispatched.push(owner); });
    }

    await chatTeardown.teardownChatRuntime(-1001, "explicitDisable");

    expect(dispatched).toEqual([...CHAT_TEARDOWN_ORDER]);
    expect(new Set(dispatched).size).toBe(CHAT_TEARDOWN_ORDER.length);
  });

  test("teardown 原因原样传给 owner，用于区分显式清理与失权停管", async () => {
    const reasons: string[] = [];
    chatTeardownRegistry.registerChatTeardown("antiRaid", (_chatId: number, reason): void => {
      reasons.push(reason);
    });

    await chatTeardown.teardownChatRuntime(-1001, "explicitDisable");
    await chatTeardown.teardownChatRuntime(-1001, "lostAuthority");

    expect(reasons).toEqual(["explicitDisable", "lostAuthority"]);
  });

  test("按 proxy、copy、gag、qa、AI、Anti-Raid 顺序拆除组合运行态", async () => {
    states.set(-1001, { isProxySendEnabled: true });
    await chatTeardown.teardownChatRuntime(-1001, "explicitDisable");
    expect(calls).toEqual([
      "clear:isProxySendEnabled",
      "copy:-1001",
      "gag:-1001",
      "qa:-1001",
      "ai:-1001:true",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.isProxySendEnabled).toBeUndefined();
  });

  test("owner 同步抛错或异步拒绝时仍启动并等待其余 teardown", async () => {
    const copyError = new Error("copy teardown failed");
    const aiError = new Error("AI teardown failed");
    states.set(-1001, { isProxySendEnabled: true });
    chatTeardownRegistry.registerChatTeardown("copy", (): never => { throw copyError; });
    chatTeardownRegistry.registerChatTeardown("gag", (chatId: number): void => { calls.push(`gag:${chatId}`); });
    chatTeardownRegistry.registerChatTeardown("aiChat", async (): Promise<void> => { throw aiError; });
    chatTeardownRegistry.registerChatTeardown("antiRaid", (chatId: number): void => { calls.push(`anti:${chatId}`); });

    const error = await chatTeardown.teardownChatRuntime(-1001, "lostAuthority")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([copyError, aiError]);
    expect(calls).toEqual([
      "clear:isProxySendEnabled",
      "gag:-1001",
      "qa:-1001",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.isProxySendEnabled).toBeUndefined();
  });

  test("退群保留尚未恢复的 lockdown owner，删除其它群配置", async () => {
    const lockdown = {
      phase: "active",
      intentId: 7,
      originalPermissions: {},
      announced: true,
      expiresAt: 9_000,
    };
    states.set(-1001, {
      isInitEnabled: true,
      botPermissions: botPermissions(),
      isProxySendEnabled: true,
      lockdown,
    });
    await botAdmin.handleMyChatMemberUpdate(memberContext("kicked"));
    expect(states.get(-1001)).toEqual({ lockdown });
    // 第二条是权限快照被丢掉时顺手排的后台写：botPermissions 是持久字段，只清内存
    // 会让磁盘继续留着一份已经作废的快照（见 infra/botAdmin.ts 的
    // forgetBotChatPermissions）。这一路后面那次 persistChatState 会以更高 revision
    // 盖过它，多出来的这次写是 teardown 每群一次的固定成本，不进任何热路径。
    expect(calls.slice(0, 10)).toEqual([
      "clear:botPermissions",
      "save:bot permissions forgotten",
      "clear:isProxySendEnabled",
      "copy:-1001",
      "gag:-1001",
      "qa:-1001",
      "ai:-1001:true",
      "anti:-1001",
      "prune:-1001",
      "save:chat -1001 state pruned after bot left/kicked",
    ]);
  });

  test("退群 teardown 失败仍裁剪并持久化权威状态，随后传播错误", async () => {
    const teardownError = new Error("anti-raid teardown failed");
    states.set(-1001, {
      isInitEnabled: true,
      botPermissions: botPermissions(),
      isProxySendEnabled: true,
    });
    chatTeardownRegistry.registerChatTeardown("antiRaid", async (): Promise<void> => { throw teardownError; });

    const error = await botAdmin.handleMyChatMemberUpdate(memberContext("left"))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([teardownError]);
    expect(states.has(-1001)).toBe(false);
    expect(calls).toContain("prune:-1001");
    expect(calls).toContain("save:chat -1001 state pruned after bot left/kicked");
  });

  test("管理员降级调用同一 teardown，并记录完整非管理员权限快照", async () => {
    states.set(-1001, {
      isInitEnabled: true,
      botPermissions: botPermissions(),
      isProxySendEnabled: true,
    });
    await botAdmin.handleMyChatMemberUpdate(memberContext("member"));
    expect(calls.slice(0, 6)).toEqual([
      "clear:isProxySendEnabled",
      "copy:-1001",
      "gag:-1001",
      "qa:-1001",
      "ai:-1001:true",
      "anti:-1001",
    ]);
    expect((states.get(-1001)?.botPermissions as { isAdministrator?: boolean })?.isAdministrator).toBe(false);
  });

  test("管理员降级 teardown 失败仍持久化非管理员权限快照，随后传播错误", async () => {
    const teardownError = new Error("AI teardown failed");
    states.set(-1001, {
      isInitEnabled: true,
      botPermissions: botPermissions(),
      isProxySendEnabled: true,
    });
    chatTeardownRegistry.registerChatTeardown("aiChat", async (): Promise<void> => { throw teardownError; });

    const error = await botAdmin.handleMyChatMemberUpdate(memberContext("member"))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([teardownError]);
    expect((states.get(-1001)?.botPermissions as { isAdministrator?: boolean })?.isAdministrator).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledWith("bot permissions refresh");
  });

  test("/init 切换后废弃旧在途结果，第一次权限判定必须重查", async () => {
    let releaseOld!: (member: { status: string }) => void;
    getChatMember.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
    states.set(-1001, { isInitEnabled: true });

    const staleCheck = botAdmin.resolveBotAdminStatus(-1001);
    botAdmin.invalidateBotAdminStatus(-1001);
    getChatMember.mockImplementationOnce(async () => ({ status: "member" }));
    const freshCheck = botAdmin.resolveBotAdminStatus(-1001);

    expect(await freshCheck).toBe(false);
    releaseOld({ status: "administrator" });
    expect(await staleCheck).toBe(false);
    expect(getChatMember).toHaveBeenCalledTimes(2);
    expect((states.get(-1001)?.botPermissions as { isAdministrator?: boolean })?.isAdministrator).toBe(false);
  });
});
