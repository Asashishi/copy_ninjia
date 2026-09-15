import { beforeEach, expect, mock, test } from "bun:test";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../../packages/types/chatState";
import { PROMPT_COMMAND_TEXTS } from "../../packages/consts/prompt";
const state: ChatState = { isInitEnabled: true };
const send = mock(async (..._args: unknown[]): Promise<void> => {});
const persist = mock(async (..._args: unknown[]): Promise<void> => {});
let allowed: boolean = false;
mock.module("../../packages/infra/storage/stateStore", () => ({ getChatState: () => state, getOrCreateChatState: () => state, persistChatState: persist }));
mock.module("../../packages/commands/commandActor", () => ({ hasCommandPermission: (_ctx: unknown, key: string) => allowed && key === "isCanConfigAiPrompt" }));
mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage: send }));
const syncPersona = mock((_chatId: number): void => {});
mock.module("../../packages/aiChat/workerBridge", () => ({ syncAiChatPersona: syncPersona }));
const { handlePromptCommand } = await import("../../packages/commands/prompt");
function context(match: string): CommandContext<Context> { return { chat: { id: -1001, type: "supergroup" }, msg: {}, msgId: 1, match } as CommandContext<Context>; }
beforeEach(() => { state.isInitEnabled = true; state.aiPersona = undefined; allowed = false; send.mockClear(); syncPersona.mockClear(); persist.mockReset(); persist.mockResolvedValue(undefined); });
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
  await handlePromptCommand(context("remove"));
  expect(state.aiPersona).toBeUndefined(); expect(persist).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: PROMPT_COMMAND_TEXTS.removed }));
});
test("持久化失败不发送成功回执", async () => {
  allowed = true; persist.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(handlePromptCommand(context("config 新人设"))).rejects.toThrow("storage unavailable");
  expect(send).not.toHaveBeenCalled();
  expect(syncPersona).not.toHaveBeenCalled();
});
