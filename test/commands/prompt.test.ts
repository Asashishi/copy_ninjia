const syncAtmosphere = mock((_chatId: number): void => {});
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({ syncAntiRaidAtmosphere: syncAtmosphere }));
const syncMenu = mock(async (): Promise<void> => {});
mock.module("../../packages/app/commandMenu", () => ({ syncChatCommandMenu: syncMenu }));
import { beforeEach, expect, mock, test } from "bun:test";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../../packages/types/chatState";
import { PROMPT_COMMAND_TEXTS } from "../../packages/consts/atmosphere/teasing/prompt";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { chatStateOf } from "../helpers/chatState";
const state: ChatState = chatStateOf({ isInitEnabled: true });
const send = mock(async (..._args: unknown[]): Promise<void> => {});
const persist = mock(async (..._args: unknown[]): Promise<void> => {});
let allowed: boolean = false;
mock.module("../../packages/infra/storage/stateStore", () => ({ getChatState: () => state, getOrCreateChatState: () => state, persistChatState: persist }));
const permissionChecks: [number, string][] = [];
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean => {
    permissionChecks.push([id, key]);
    return allowed && id === 7 && key === "isCanConfigAiPrompt";
  },
}));
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage: send }));
const syncPersona = mock((_chatId: number): void => {});
mock.module("../../packages/aiChat/workerBridge", () => ({ syncAiChatPersona: syncPersona }));
const { handlePromptCommand } = await import("../../packages/commands/prompt");
function context(match: string, msg: object = {}, from: object | null = { id: 7, is_bot: false, first_name: "管理员" }): CommandContext<Context> {
  const chat = { id: -1001, type: "supergroup" };
  return { chat, msg: { chat, ...msg }, from: from ?? undefined, msgId: 1, match } as CommandContext<Context>;
}
beforeEach(() => { state.isInitEnabled = true; state.aiPersona = undefined; allowed = false; permissionChecks.length = 0; send.mockClear(); syncPersona.mockClear(); syncAtmosphere.mockClear(); syncMenu.mockClear(); persist.mockReset(); persist.mockResolvedValue(undefined); });
test("无权限不配置，未初始化不写入", async () => {
  await handlePromptCommand(context("config 新人设"));
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.rejected }));
  allowed = true; state.isInitEnabled = false;
  await handlePromptCommand(context("config 新人设"));
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.notInitialized }));
  expect(persist).not.toHaveBeenCalled();
});
test.each(["", "config", "config   ", "remove extra", "other test"])("非法参数 %s 不写入", async (input) => {
  allowed = true; await handlePromptCommand(context(input));
  expect(state.aiPersona).toBeUndefined(); expect(persist).not.toHaveBeenCalled();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.usage }));
});
test("完整多行人设被持久化，remove 恢复缺省且回执走统一清理边界", async () => {
  allowed = true; await handlePromptCommand(context("config 温和说话\n保持 简短"));
  expect(state.aiPersona).toBe("温和说话\n保持 简短");
  expect(persist).toHaveBeenCalledTimes(1);
  expect(syncPersona).toHaveBeenCalledWith(-1001);
  expect(syncAtmosphere).toHaveBeenCalledWith(-1001);
  expect(syncMenu).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: ATMOSPHERE_TEXTS.plain.PROMPT_COMMAND_TEXTS.configured }));
  await handlePromptCommand(context("remove"));
  expect(state.aiPersona).toBeUndefined(); expect(persist).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.removed }));
});
test("持久化失败不发送成功回执", async () => {
  allowed = true; persist.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(handlePromptCommand(context("config 新人设"))).rejects.toThrow("storage unavailable");
  expect(send).not.toHaveBeenCalled();
  expect(syncPersona).not.toHaveBeenCalled();
  expect(syncAtmosphere).not.toHaveBeenCalled();
  expect(syncMenu).not.toHaveBeenCalled();
});

test("自定义人设存在时，权限拒绝和用法提示也使用普通版", async () => {
  state.aiPersona = "本天才♡ 这段是用户提示词";
  await handlePromptCommand(context("remove"));
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: ATMOSPHERE_TEXTS.plain.PROMPT_COMMAND_TEXTS.rejected }));
  allowed = true;
  await handlePromptCommand(context("config"));
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: ATMOSPHERE_TEXTS.plain.PROMPT_COMMAND_TEXTS.usage }));
  expect(state.aiPersona).toBe("本天才♡ 这段是用户提示词");
  expect(persist).not.toHaveBeenCalled();
});

test("权限按真实可见发起身份判定：频道马甲按频道 id，解析不出发起身份一律拒绝", async () => {
  allowed = true;
  await handlePromptCommand(context("config 新人设", { sender_chat: { id: -100555, type: "channel", title: "频道" } }));
  expect(permissionChecks).toEqual([[-100555, "isCanConfigAiPrompt"]]);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.rejected }));

  await handlePromptCommand(context("config 新人设", {}, null));
  expect(permissionChecks).toHaveLength(1);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.rejected }));
  expect(persist).not.toHaveBeenCalled();
});
