/**
 * send_voice 行动工具：工具声明恒定、单轮限额、实现缺席、参数校验，
 * 以及接纳后「正在录音」→ idle → 发送 → 自录的发送链；合成、编码与发送失败
 * 各自返回不可重试错误且不自录。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { sineWav } from "../../helpers/wav";
import type { ReplyToolContext, ReplyToolExecution } from "../../../packages/types/aiChat/replies";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";
import type { TelegramSendResult } from "../../../packages/types/telegram";

const synthesizeSpeech = mock(async (..._args: unknown[]): Promise<SynthesizedSpeech | null> => ({
  bytes: sineWav(24_000, 1.2),
  mimeType: "audio/wav",
}));
const ttsAiProvider = mock((): unknown => ({ name: "google", synthesizeSpeech }));
const sendVoiceWithResult = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: 77,
  repliedToMessageId: 42,
}));
const loggerError = mock((..._args: unknown[]): void => {});

const realProvider = await import("../../../packages/aiChat/provider");
const realTelegram = await import("../../../packages/infra/telegram");
mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, ttsAiProvider }));
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendVoiceWithResult }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const {
  buildSendVoiceToolDefinition,
  createSendVoiceExecutor,
} = await import("../../../packages/aiChat/ai/tools/replyToolset/voiceMessage");
const { VOICE_FILE_NAME, VOICE_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } = await import("../../../packages/consts/aiChat/voiceMessage");
const { SEND_VOICE_TOOL_INSTRUCTION } = await import("../../../packages/consts/aiChat/prompts/tools");

function buildContext(overrides: Partial<ReplyToolContext> = {}): ReplyToolContext {
  return {
    chatId: -1001,
    replyToMessageId: 42,
    messageThreadId: 9,
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

async function runVoice(ctx: ReplyToolContext, args: Record<string, unknown>): Promise<{ accepted: string; result: string }> {
  const execution: ReplyToolExecution = createSendVoiceExecutor(ctx)(JSON.stringify(args));
  if (typeof execution === "string") return { accepted: execution, result: execution };
  return { accepted: execution.result, result: await execution.run(ctx.chatAction) };
}

function errorOf(result: string): string | undefined {
  return (JSON.parse(result) as { error?: string }).error;
}

beforeEach(() => {
  for (const mocked of [synthesizeSpeech, ttsAiProvider, sendVoiceWithResult, loggerError]) mocked.mockClear();
  synthesizeSpeech.mockImplementation(async (): Promise<SynthesizedSpeech | null> => ({
    bytes: sineWav(24_000, 1.2),
    mimeType: "audio/wav",
  }));
  ttsAiProvider.mockImplementation((): unknown => ({ name: "google", synthesizeSpeech }));
  sendVoiceWithResult.mockImplementation(async (): Promise<TelegramSendResult | undefined> => ({
    messageId: 77,
    repliedToMessageId: 42,
  }));
});

describe("send_voice 声明", () => {
  test("工具声明逐字恒定，说明里要求积极使用", () => {
    const definition = buildSendVoiceToolDefinition();
    expect(definition.name).toBe("send_voice");
    expect(definition.description).toBe(SEND_VOICE_TOOL_INSTRUCTION);
    expect(definition.parametersJsonSchema).toMatchObject({
      required: ["text"],
      properties: { text: { maxLength: VOICE_TEXT_MAX_CHARS }, tone: { type: "string", maxLength: VOICE_TONE_MAX_CHARS } },
    });
    expect(JSON.stringify(buildSendVoiceToolDefinition())).toBe(JSON.stringify(definition));
    expect(definition.description).toContain("要积极使用");
  });
});

describe("send_voice 接纳闸", () => {
  test("本轮已作废时拒绝", async () => {
    const { result } = await runVoice(buildContext({ isActive: () => false }), { text: "バカ" });
    expect(errorOf(result)).toBe("Reply invalidated because AI chat was disabled");
  });

  test("单轮只接纳一条", () => {
    const execute = createSendVoiceExecutor(buildContext());
    expect(typeof execute(JSON.stringify({ text: "バカ" }))).toBe("object");
    const second: ReplyToolExecution = execute(JSON.stringify({ text: "ざぁこ" }));
    expect(typeof second === "string" && errorOf(second)).toContain("Voice limit reached");
  });

  test("所选实现没有语音合成或未配置时拒绝", async () => {
    ttsAiProvider.mockImplementation((): unknown => ({ name: "openai" }));
    expect(errorOf((await runVoice(buildContext(), { text: "バカ" })).result))
      .toBe("Voice is unavailable: the openai provider does not support speech synthesis");
    ttsAiProvider.mockImplementation((): unknown => null);
    expect(errorOf((await runVoice(buildContext(), { text: "バカ" })).result))
      .toBe("Voice is unavailable: the unconfigured provider does not support speech synthesis");
  });

  test.each([
    [{}],
    [{ text: 1 }],
    [{ text: "   " }],
    [{ text: "あ".repeat(VOICE_TEXT_MAX_CHARS + 1) }],
    [{ text: "バカ", reply_to_trigger: "yes" }],
    [{ text: "バカ", tone: 1 }],
    [{ text: "バカ", tone: "あ".repeat(VOICE_TONE_MAX_CHARS + 1) }],
  ])("参数非法时拒绝：%j", async (args: Record<string, unknown>) => {
    const { result } = await runVoice(buildContext(), args);
    expect(errorOf(result)).toStartWith("Invalid voice arguments");
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });
});

describe("send_voice 发送链", () => {
  test("接纳预占一个动作；合成期间亮录音状态，发送前切回 idle 并收敛", async () => {
    const ctx: ReplyToolContext = buildContext();
    const events: string[] = [];
    (ctx.chatAction.set as ReturnType<typeof mock>).mockImplementation((phase: unknown): void => {
      events.push(String(phase));
    });
    (ctx.chatAction.settle as ReturnType<typeof mock>).mockImplementation(async (): Promise<void> => {
      events.push("settled");
    });
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SynthesizedSpeech | null> => {
      events.push("synthesized");
      return { bytes: sineWav(24_000, 1.2), mimeType: "audio/wav" };
    });
    sendVoiceWithResult.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => {
      events.push("sent");
      return { messageId: 77, repliedToMessageId: 42 };
    });

    const { accepted, result } = await runVoice(ctx, { text: "  この雑魚♡\nバーカ ", reply_to_trigger: true });

    expect(JSON.parse(accepted)).toEqual({ success: true, queued: true, actions_used: 1 });
    expect(JSON.parse(result)).toEqual({ success: true, message_id: 77, actions_used: 1 });
    expect(events).toEqual(["record_voice", "synthesized", "idle", "settled", "sent"]);
    expect(synthesizeSpeech.mock.calls[0]![0]).toStrictEqual({ text: "この雑魚♡ バーカ", tone: undefined, signal: undefined });
    const sendArgs = sendVoiceWithResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendArgs).toMatchObject({
      chatId: -1001,
      fileName: VOICE_FILE_NAME,
      replyToMessageId: 42,
      messageThreadId: 9,
      duration: 2,
    });
    expect(new TextDecoder().decode((sendArgs.bytes as Uint8Array).subarray(0, 4))).toBe("OggS");
    expect(ctx.onVoiceSent).toHaveBeenCalledWith("（发送了一条语音：この雑魚♡ バーカ）", 77, 42);
  });

  test("tone 清洗成单行后随台词交给合成；null 与空白按未给出处理", async () => {
    await runVoice(buildContext(), { text: "バカ", tone: " 鼻で笑うように\n小声で " });
    expect(synthesizeSpeech.mock.calls[0]![0]).toStrictEqual({ text: "バカ", tone: "鼻で笑うように 小声で", signal: undefined });

    for (const tone of [null, "   "]) {
      synthesizeSpeech.mockClear();
      await runVoice(buildContext(), { text: "バカ", tone });
      expect(synthesizeSpeech.mock.calls[0]![0]).toStrictEqual({ text: "バカ", tone: undefined, signal: undefined });
    }
  });

  test("未要求挂回复时不带回复目标", async () => {
    await runVoice(buildContext(), { text: "バカ" });
    expect((sendVoiceWithResult.mock.calls[0]![0] as Record<string, unknown>).replyToMessageId).toBeUndefined();
  });

  test("合成失败或返回不可编码的音频时不发送、不自录", async () => {
    const ctx: ReplyToolContext = buildContext();
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SynthesizedSpeech | null> => null);
    expect(errorOf((await runVoice(ctx, { text: "バカ" })).result))
      .toBe("Voice synthesis failed or returned no usable audio");

    synthesizeSpeech.mockImplementationOnce(async (): Promise<SynthesizedSpeech | null> => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mp3",
    }));
    expect(errorOf((await runVoice(ctx, { text: "バカ" })).result))
      .toBe("Voice synthesis failed or returned no usable audio");
    expect(loggerError).toHaveBeenCalledWith("Voice message encoding failed (chat -1001): unsupported speech mime type.");
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(ctx.onVoiceSent).not.toHaveBeenCalled();
    expect(ctx.chatAction.set).toHaveBeenLastCalledWith("idle");
  });

  test("合成期间本轮作废时不编码、不发送", async () => {
    let active: boolean = true;
    const ctx: ReplyToolContext = buildContext({ isActive: () => active });
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SynthesizedSpeech | null> => {
      active = false;
      return { bytes: sineWav(24_000, 0.5), mimeType: "audio/wav" };
    });
    expect(errorOf((await runVoice(ctx, { text: "バカ" })).result))
      .toBe("Reply invalidated because AI chat was disabled");
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
  });

  test("接纳后、执行前作废时直接返回作废错误", async () => {
    let active: boolean = true;
    const ctx: ReplyToolContext = buildContext({ isActive: () => active });
    const execution: ReplyToolExecution = createSendVoiceExecutor(ctx)(JSON.stringify({ text: "バカ" }));
    if (typeof execution === "string") throw new Error("expected an accepted voice action");
    active = false;
    expect(errorOf(await execution.run(ctx.chatAction))).toBe("Reply invalidated because AI chat was disabled");
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  test("发送失败返回不可重试错误且不自录", async () => {
    const ctx: ReplyToolContext = buildContext();
    sendVoiceWithResult.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => undefined);
    const { result } = await runVoice(ctx, { text: "バカ" });
    expect(JSON.parse(result)).toEqual({ error: "Failed to send voice message", retryable: false });
    expect(ctx.onVoiceSent).not.toHaveBeenCalled();
  });
});
