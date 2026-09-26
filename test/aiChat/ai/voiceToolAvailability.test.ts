/**
 * send_voice 的挂载：只看部署能力、不看触发类型，挂载后每轮都可直接调用；未挂载时
 * 点名调用归一成未知工具；执行计入共享动作预算。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, ReplyToolset } from "../../../packages/types/aiChat/replies";
import type { AiToolDefinition } from "../../../packages/types/aiChat/provider";
import { loggerStub } from "../../helpers/loggerMock";

const synthesizeSpeech = mock(async (..._args: unknown[]): Promise<{ ok: false; reason: "synthesis failed" }> => ({
  ok: false,
  reason: "synthesis failed",
}));
const ttsAiProvider = mock((): unknown => ({ name: "google", synthesizeSpeech }));
const realTelegram = await import("../../../packages/infra/telegram");
const realProvider = await import("../../../packages/aiChat/provider");

mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, ttsAiProvider }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub() }));
mock.module("../../../packages/infra/telegram", () => ({
  ...realTelegram,
  telegramApi: { getStickerSet: mock(async (): Promise<null> => null) },
}));

const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const { ACTION_TOOL_NAMES, SEND_VOICE_TOOL } = await import("../../../packages/consts/tools");

function buildContext(overrides: Partial<ReplyToolContext> = {}): ReplyToolContext {
  return {
    chatId: -1002,
    replyToMessageId: 5,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    chatAction: {
      current: (): "idle" => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onVoiceSent: mock((..._args: unknown[]): void => {}),
    ...overrides,
  };
}

function toolNames(toolset: ReplyToolset): string[] {
  return toolset.functions.map((definition: AiToolDefinition): string => definition.name);
}

beforeEach(() => {
  ttsAiProvider.mockClear();
  synthesizeSpeech.mockClear();
  ttsAiProvider.mockImplementation((): unknown => ({ name: "google", synthesizeSpeech }));
});

describe("语音工具的挂载", () => {
  test("直接触发与非直接触发轮都挂 send_voice，工具声明逐字相同", async () => {
    const random: ReplyToolset = await createReplyToolset(buildContext({ mediaToolsRequested: false }));
    const direct: ReplyToolset = await createReplyToolset(buildContext({ mediaToolsRequested: true }));
    const voiceDeclaration = (toolset: ReplyToolset): string =>
      JSON.stringify(toolset.functions.find((definition: AiToolDefinition): boolean => definition.name === SEND_VOICE_TOOL));

    expect(toolNames(random)).toContain(SEND_VOICE_TOOL);
    expect(random.has(SEND_VOICE_TOOL)).toBe(true);
    expect(direct.has(SEND_VOICE_TOOL)).toBe(true);
    expect(voiceDeclaration(random)).toBe(voiceDeclaration(direct));
  });

  test("实现不具备语音合成或未配置时不挂，点名调用归一成未知工具", async () => {
    for (const provider of [{ name: "openai" }, null]) {
      ttsAiProvider.mockImplementation((): unknown => provider);
      const toolset: ReplyToolset = await createReplyToolset(buildContext());

      expect(toolNames(toolset)).not.toContain(SEND_VOICE_TOOL);
      const result = JSON.parse(await toolset.execute(SEND_VOICE_TOOL, JSON.stringify({ text: "バカ" })));
      expect(result.error).toBe(`Unknown tool: ${SEND_VOICE_TOOL}`);
      expect(toolset.actionsUsed()).toBe(0);
    }
  });

  test("接纳的语音计入共享动作预算", async () => {
    const toolset: ReplyToolset = await createReplyToolset(buildContext());
    const result = JSON.parse(await toolset.execute(SEND_VOICE_TOOL, JSON.stringify({ text: "バカ" })));

    expect(result).toEqual({ success: true, queued: true, actions_used: 1, voice_remaining_today: 74 });
    expect(toolset.actionsUsed()).toBe(1);
    await toolset.settle();
    expect(ACTION_TOOL_NAMES).toContain(SEND_VOICE_TOOL);
  });
});
