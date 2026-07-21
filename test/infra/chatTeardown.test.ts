import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: string[] = [];
const states = new Map<number, Record<string, unknown>>();
const saveStateInBackground = mock((context: string): void => { calls.push(`save:${context}`); });

mock.module("../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../src/infra/telegram", () => ({
  bot: { botInfo: { id: 99 }, api: { getChatMember: async () => ({ status: "administrator" }) } },
}));
mock.module("../../src/infra/storage/stateStore", () => ({
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
  saveStateInBackground,
}));

const botAdmin = await import("../../src/infra/botAdmin");
const chatTeardown = await import("../../src/infra/chatTeardown");

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
  chatTeardown.registerChatTeardown("copy", (chatId: number): void => { calls.push(`copy:${chatId}`); });
  chatTeardown.registerChatTeardown("aiChat", (chatId: number): void => { calls.push(`ai:${chatId}:true`); });
  chatTeardown.registerChatTeardown("antiRaid", (chatId: number): void => { calls.push(`anti:${chatId}`); });
});

describe("chat runtime teardown", () => {
  test("按 copy、proxy、AI、Anti-Raid 顺序拆除组合运行态", () => {
    states.set(-1001, { isProxySendEnabled: true });
    botAdmin.teardownChatRuntime(-1001);
    expect(calls).toEqual([
      "copy:-1001",
      "clear:isProxySendEnabled",
      "ai:-1001:true",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.isProxySendEnabled).toBeUndefined();
  });

  test("退群保留尚未恢复的 lockdown owner，删除其它群配置", () => {
    const lockdown = { phase: "active", intentId: 7, originalPermissions: {}, expiresAt: 9_000 };
    states.set(-1001, {
      isInitEnabled: true,
      botIsAdmin: true,
      isProxySendEnabled: true,
      lockdown,
    });
    botAdmin.handleMyChatMemberUpdate(memberContext("kicked"));
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

  test("管理员降级调用同一 teardown，并记录 botIsAdmin=false", () => {
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true, isProxySendEnabled: true });
    botAdmin.handleMyChatMemberUpdate(memberContext("member"));
    expect(calls.slice(0, 4)).toEqual([
      "copy:-1001",
      "clear:isProxySendEnabled",
      "ai:-1001:true",
      "anti:-1001",
    ]);
    expect(states.get(-1001)?.botIsAdmin).toBe(false);
  });
});
