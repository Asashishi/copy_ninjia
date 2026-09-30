/**
 * send_voice 的挂载：只看部署能力（`agent.tts` 已配置且所选实现具备语音合成）、不看触发类型，
 * 挂载后每轮都可直接调用；未挂载时点名调用归一成未知工具。准入通过即当场交回接纳回执并预占
 * 一个共享动作，与之后合成成败无关；合成失败时链上不发送、不计完成动作。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, ReplyToolset } from "../../../packages/types/aiChat/replies";
import type { AiToolDefinition } from "../../../packages/types/aiChat/provider";
import type { SpeechSynthesisAttempt } from "../../../packages/types/aiChat/voiceMessage";
import { loggerStub } from "../../helpers/loggerMock";
import { sineWav } from "../../helpers/wav";

const synthesizeSpeech = mock(async (..._args: unknown[]): Promise<SpeechSynthesisAttempt> => ({
  ok: false,
  reason: "synthesis failed",
}));
const ttsAiProvider = mock((): unknown => ({ name: "google", synthesizeSpeech }));
const realTelegram = await import("../../../packages/infra/telegram");
const realProvider = await import("../../../packages/aiChat/provider");

mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, ttsAiProvider }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub() }));
// 投递前按音频时长补「正在录音」的停顿不真的等。
mock.module("../../../packages/libs/sleep", () => ({ sleep: async (): Promise<void> => {} }));
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
    direct: false,
    chatAction: {
      set: mock((..._args: unknown[]): number => 0),
      settle: mock(async (): Promise<void> => {}),
    },
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
      const result = JSON.parse(toolset.execute(SEND_VOICE_TOOL, JSON.stringify({ text: "バカ" })));
      expect(result.error).toBe(`Unknown tool: ${SEND_VOICE_TOOL}`);
      expect(toolset.actionsUsed()).toBe(0);
    }
  });

  test("准入通过即当场交回接纳回执并预占一个共享动作，send_voice 属于共享动作工具", async () => {
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> =>
      ({ ok: true, speech: { bytes: sineWav(24_000, 0.5), mimeType: "audio/wav" } }));
    const toolset: ReplyToolset = await createReplyToolset(buildContext());
    const result = JSON.parse(toolset.execute(SEND_VOICE_TOOL, JSON.stringify({ text: "バカ" })));

    expect(result).toMatchObject({ success: true, queued: true, actions_used: 1 });
    expect(toolset.actionsUsed()).toBe(1);
    await toolset.settle();
    expect(ACTION_TOOL_NAMES).toContain(SEND_VOICE_TOOL);
  });

  test("合成失败时回执照常接纳并占共享动作预算，链上不发送、不计完成动作", async () => {
    const toolset: ReplyToolset = await createReplyToolset(buildContext());
    const result = JSON.parse(toolset.execute(SEND_VOICE_TOOL, JSON.stringify({ text: "バカ" })));

    expect(result).toMatchObject({ success: true, queued: true, actions_used: 1 });
    expect(toolset.actionsUsed()).toBe(1);
    await toolset.settle();
    expect(toolset.actionsCompleted()).toBe(0);
  });
});
