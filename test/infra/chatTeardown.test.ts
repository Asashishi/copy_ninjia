import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: string[] = [];
const states = new Map<number, Record<string, unknown>>();
const saveStateInBackground = mock((context: string): void => { calls.push(`save:${context}`); });
const getChatMember = mock(async (): Promise<{ status: string }> => ({ status: "administrator" }));

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/telegram", () => ({
  bot: { botInfo: { id: 99 }, api: { getChatMember } },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
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
  persistAuthoritativeState: async (context: string): Promise<void> => { saveStateInBackground(context); },
  saveStateInBackground,
}));

const botAdmin = await import("../../packages/infra/botAdmin");
const botAdminCache = await import("../../packages/cache/botAdmin");
const chatTeardown = await import("../../packages/infra/chatTeardown");

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
  botAdminCache.botAdminFetches.clear();
  botAdminCache.botAdminGenerations.clear();
  botAdminCache.botAdminGenerationUsers.clear();
  chatTeardown.registerChatTeardown("copy", (chatId: number): void => { calls.push(`copy:${chatId}`); });
  chatTeardown.registerChatTeardown("aiChat", (chatId: number): void => { calls.push(`ai:${chatId}:true`); });
  chatTeardown.registerChatTeardown("antiRaid", (chatId: number): void => { calls.push(`anti:${chatId}`); });
});

describe("chat runtime teardown", () => {
  test("按 copy、proxy、AI、Anti-Raid 顺序拆除组合运行态", async () => {
    states.set(-1001, { isProxySendEnabled: true });
    await botAdmin.teardownChatRuntime(-1001);
    expect(calls).toEqual([
      "copy:-1001",
      "clear:isProxySendEnabled",
      "ai:-1001:true",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.isProxySendEnabled).toBeUndefined();
  });

  test("owner 同步抛错或异步拒绝时仍启动并等待其余 teardown", async () => {
    const copyError = new Error("copy teardown failed");
    const aiError = new Error("AI teardown failed");
    states.set(-1001, { isProxySendEnabled: true });
    chatTeardown.registerChatTeardown("copy", (): never => { throw copyError; });
    chatTeardown.registerChatTeardown("aiChat", async (): Promise<void> => { throw aiError; });
    chatTeardown.registerChatTeardown("antiRaid", (chatId: number): void => { calls.push(`anti:${chatId}`); });

    const error = await botAdmin.teardownChatRuntime(-1001).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([copyError, aiError]);
    expect(calls).toEqual([
      "clear:isProxySendEnabled",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.isProxySendEnabled).toBeUndefined();
  });

  test("退群保留尚未恢复的 lockdown owner，删除其它群配置", async () => {
    const lockdown = { phase: "active", intentId: 7, originalPermissions: {}, expiresAt: 9_000 };
    states.set(-1001, {
      isInitEnabled: true,
      botIsAdmin: true,
      isProxySendEnabled: true,
      lockdown,
    });
    await botAdmin.handleMyChatMemberUpdate(memberContext("kicked"));
    expect(states.get(-1001)).toEqual({ lockdown });
    expect(calls.slice(0, 6)).toEqual([
      "copy:-1001",
      "clear:isProxySendEnabled",
      "ai:-1001:true",
      "anti:-1001",
      "prune:-1001",
      "save:chat -1001 state pruned after bot left/kicked",
    ]);
  });

  test("退群 teardown 失败仍裁剪并持久化权威状态，随后传播错误", async () => {
    const teardownError = new Error("anti-raid teardown failed");
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true, isProxySendEnabled: true });
    chatTeardown.registerChatTeardown("antiRaid", async (): Promise<void> => { throw teardownError; });

    const error = await botAdmin.handleMyChatMemberUpdate(memberContext("left"))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([teardownError]);
    expect(states.has(-1001)).toBe(false);
    expect(calls).toContain("prune:-1001");
    expect(calls).toContain("save:chat -1001 state pruned after bot left/kicked");
  });

  test("管理员降级调用同一 teardown，并记录 botIsAdmin=false", async () => {
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true, isProxySendEnabled: true });
    await botAdmin.handleMyChatMemberUpdate(memberContext("member"));
    expect(calls.slice(0, 4)).toEqual([
      "copy:-1001",
      "clear:isProxySendEnabled",
      "ai:-1001:true",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.botIsAdmin).toBe(false);
  });

  test("管理员降级 teardown 失败仍持久化 botIsAdmin=false，随后传播错误", async () => {
    const teardownError = new Error("AI teardown failed");
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true, isProxySendEnabled: true });
    chatTeardown.registerChatTeardown("aiChat", async (): Promise<void> => { throw teardownError; });

    const error = await botAdmin.handleMyChatMemberUpdate(memberContext("member"))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([teardownError]);
    expect(states.get(-1001)?.botIsAdmin).toBe(false);
    expect(saveStateInBackground).toHaveBeenCalledWith("bot admin status refresh");
  });

  test("/init 切换后废弃旧在途结果，第一次权限判定必须重查", async () => {
    let releaseOld!: (member: { status: string }) => void;
    getChatMember.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
    states.set(-1001, { isInitEnabled: true });

    const staleCheck = botAdmin.isBotAdminIn(-1001);
    botAdmin.invalidateBotAdminStatus(-1001);
    getChatMember.mockImplementationOnce(async () => ({ status: "member" }));
    const freshCheck = botAdmin.isBotAdminIn(-1001);

    expect(await freshCheck).toBe(false);
    releaseOld({ status: "administrator" });
    expect(await staleCheck).toBe(false);
    expect(getChatMember).toHaveBeenCalledTimes(2);
    expect(states.get(-1001)?.botIsAdmin).toBe(false);
  });
});
