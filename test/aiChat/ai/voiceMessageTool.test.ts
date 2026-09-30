import { TTS_DEFAULT_STYLE } from "../../../packages/consts/aiChat/voiceMessage";
/**
 * send_voice 行动工具：工具声明逐字恒定与本轮工具状态的语音余量行；准入闸（本轮作废、单轮限额、
 * 实现缺席、参数校验、按 `ai` 口径预留每日额度）在调用时同步判定，拒绝时在回执里当场返回错误，
 * 通过即当场交回接纳回执并预占一个动作，在后台开始合成。每日计数只在 TTS 调用成功时登记（之后
 * 编码失败也不退回），TTS 失败或抛错只释放预留。执行器交回的投递步骤：等合成期间亮「正在录音」，
 * 合成好后再按语音时长模拟「正在录音」→ idle → 收敛 → 发送并自录；前台窗口到点仍在合成时收回
 * 录音、经 chains.defer 转入后台，合成成功后补发。合成或编码失败只记英文日志、不投递、不自录；
 * 发送失败由投递步骤返回不可重试错误且不自录。
 */

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { sineWav } from "../../helpers/wav";
import type { AgentDeploymentConfig, AgentTtsCapabilityConfig } from "../../../packages/types/config";
import type {
  PreparedReplyAction,
  ReplyActionChains,
  ReplyActionRun,
  ReplyToolContext,
  ReplyToolExecution,
} from "../../../packages/types/aiChat/replies";
import type { SpeechSynthesisAttempt } from "../../../packages/types/aiChat/voiceMessage";
import type { TelegramSendResult } from "../../../packages/types/telegram";
import { REPLY_INVALIDATED_TOOL_ERROR, SEND_VOICE_TOOL } from "../../../packages/consts/tools";

/** 门面交回的一次成功合成。 */
function spoken(bytes: Uint8Array, mimeType: string = "audio/wav"): SpeechSynthesisAttempt {
  return { ok: true, speech: { bytes, mimeType } };
}

const synthesizeSpeech = mock(async (..._args: unknown[]): Promise<SpeechSynthesisAttempt> => spoken(sineWav(24_000, 1.2)));
const ttsAiProvider = mock((): unknown => ({ name: "google", synthesizeSpeech }));
const sendVoiceWithResult = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: 77,
  repliedToMessageId: 42,
}));
const loggerError = mock((..._args: unknown[]): void => {});
const sleep = mock(async (_ms: number, _signal?: AbortSignal): Promise<void> => {});

const realProvider = await import("../../../packages/aiChat/provider");
const realTelegram = await import("../../../packages/infra/telegram");
mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, ttsAiProvider }));
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendVoiceWithResult }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
mock.module("../../../packages/libs/sleep", () => ({ sleep }));

const {
  buildSendVoiceToolDefinition,
  createSendVoiceExecutor,
} = await import("../../../packages/aiChat/ai/tools/replyToolset/voiceMessage");
const { buildToolStatusBlock } = await import("../../../packages/aiChat/ai/tools/replyToolset/toolStatus");
const {
  TTS_USAGE_WINDOW_MS,
  VOICE_FOREGROUND_WAIT_MS,
  VOICE_OGG_FILE_NAME,
  VOICE_TEXT_MAX_CHARS,
  VOICE_TONE_MAX_CHARS,
} = await import("../../../packages/consts/aiChat/voiceMessage");
const { pendingAiTtsReservations, ttsDailyUsage } = await import("../../../packages/cache/workers/aiChat/ttsUsage");
const { SEND_VOICE_DAILY_LIMIT_TOOL_ERROR } = await import("../../../packages/consts/tools");
const { SEND_VOICE_TOOL_INSTRUCTION, TOOL_STATUS_POINTER, voiceToolStatus } = await import("../../../packages/consts/aiChat/prompts/tools");
const { adoptAgentDeploymentConfig } = await import("../../../packages/config/agent");
const { encodeVoiceMessage } = await import("../../../packages/aiChat/ai/voiceEncoding");
const { createSimulatedPause } = await import("../../../packages/aiChat/ai/tools/replyToolset/pacing");
const { OGG_OPUS_MIME_TYPE } = await import("../../../packages/consts/audio");

const CAPABILITY = { provider: "google", apiKey: "key", baseUrl: undefined, headers: undefined, model: "m" } as const;

/** 只有 tts 段参与本文件的余量计算；其余能力只为满足配置形态。 */
function adoptTtsQuota(dailyLimit: number, dailyReserveQuota: number): void {
  const tts: AgentTtsCapabilityConfig = { ...CAPABILITY, voice: "Leda", speechProtocol: undefined, style: TTS_DEFAULT_STYLE, language: undefined, dailyLimit, dailyReserveQuota };
  const config: AgentDeploymentConfig = { text: CAPABILITY, summary: CAPABILITY, media: CAPABILITY, tts };
  adoptAgentDeploymentConfig(config);
}

function buildContext(overrides: Partial<ReplyToolContext> = {}): ReplyToolContext {
  return {
    chatId: -1001,
    replyToMessageId: 42,
    messageThreadId: 9,
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

/** 只记录后台登记的串行链替身；投递步骤由执行器交回、由用例按需执行，执行器不得自己排链。 */
interface RecordedChains extends ReplyActionChains {
  readonly deferred: Promise<ReplyActionRun | null>[];
}

function recordedChains(): RecordedChains {
  const deferred: Promise<ReplyActionRun | null>[] = [];
  return {
    deferred,
    start: (): void => {
      throw new Error("send_voice must hand its delivery step back instead of starting it");
    },
    defer: (_name: string, pending: Promise<ReplyActionRun | null>): void => {
      deferred.push(pending);
    },
    settle: async (): Promise<void> => {},
    completed: (): number => 0,
  };
}

/** 接纳通过时交回的回执与投递步骤；被拒（字符串）时让用例当场失败。 */
function preparedVoice(execution: ReplyToolExecution): PreparedReplyAction {
  if (typeof execution === "string") throw new Error(`expected an accepted voice, got ${execution}`);
  return execution;
}

/** 按空闲串行链执行一次调用：准入通过后立即执行交回的投递步骤；被拒时 result 同回执。 */
async function runVoice(ctx: ReplyToolContext, args: Record<string, unknown>): Promise<{ accepted: string; result: string }> {
  const execution: ReplyToolExecution = createSendVoiceExecutor(ctx, recordedChains())(JSON.stringify(args));
  if (typeof execution === "string") return { accepted: execution, result: execution };
  return { accepted: execution.result, result: await execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction)) };
}

/** 记下心跳切挡、收敛与合成、发送的先后顺序。 */
function recordEvents(ctx: ReplyToolContext): string[] {
  const events: string[] = [];
  (ctx.chatAction.set as ReturnType<typeof mock>).mockImplementation((phase: unknown): number => {
    events.push(String(phase));
    return 0;
  });
  (ctx.chatAction.settle as ReturnType<typeof mock>).mockImplementation(async (): Promise<void> => {
    events.push("settled");
  });
  sendVoiceWithResult.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => {
    events.push("sent");
    return { messageId: 77, repliedToMessageId: 42 };
  });
  return events;
}

function errorOf(result: string): string | undefined {
  return (JSON.parse(result) as { error?: string }).error;
}

afterEach(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  for (const mocked of [synthesizeSpeech, ttsAiProvider, sendVoiceWithResult, loggerError, sleep]) mocked.mockReset();
  synthesizeSpeech.mockImplementation(async (): Promise<SpeechSynthesisAttempt> => spoken(sineWav(24_000, 1.2)));
  ttsDailyUsage.current = null;
  pendingAiTtsReservations.current = 0;
  adoptTtsQuota(100, 25);
  ttsAiProvider.mockImplementation((): unknown => ({ name: "google", synthesizeSpeech }));
  sendVoiceWithResult.mockImplementation(async (): Promise<TelegramSendResult | undefined> => ({
    messageId: 77,
    repliedToMessageId: 42,
  }));
});

describe("send_voice 声明", () => {
  test("工具声明逐字恒定，说明按情绪与余量使用、允许不发", () => {
    const definition = buildSendVoiceToolDefinition();
    expect(definition.name).toBe(SEND_VOICE_TOOL);
    expect(definition.description).toBe(SEND_VOICE_TOOL_INSTRUCTION);
    expect(definition.parametersJsonSchema).toMatchObject({
      required: ["text"],
      properties: { text: { maxLength: VOICE_TEXT_MAX_CHARS }, tone: { type: "string", maxLength: VOICE_TONE_MAX_CHARS } },
    });
    expect(JSON.stringify(buildSendVoiceToolDefinition())).toBe(JSON.stringify(definition));
    expect(definition.description).toContain("语音用来表达情绪");
    expect(definition.description).toContain("整轮不发语音也完全可以");
    expect(definition.description).toContain(TOOL_STATUS_POINTER);
    // 额度数字只出现在余量行里，改 agent.tts 不改工具声明。
    expect(definition.description).not.toMatch(/\d+ 次/);
    adoptTtsQuota(10, 4);
    expect(buildSendVoiceToolDefinition().description).toBe(definition.description);
  });

  test("本轮工具状态的语音行按 75 次口径计算；部署没有语音能力时不出这一行", () => {
    const voiceLine = (): string =>
      buildToolStatusBlock({ ctx: buildContext(), imageEnabled: false, voiceEnabled: true }).split("\n")[1]!;
    ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 10, reserveCount: 25 };
    expect(voiceLine()).toBe(voiceToolStatus(65, 75));
    ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 80, reserveCount: 0 };
    expect(voiceLine()).toBe(voiceToolStatus(0, 75));
    // 窗口已满一天：按从没用过计算。
    ttsDailyUsage.current = { windowStartedAt: Date.now() - TTS_USAGE_WINDOW_MS, agentCount: 75, reserveCount: 25 };
    expect(voiceLine()).toBe(voiceToolStatus(75, 75));
    expect(buildToolStatusBlock({ ctx: buildContext(), imageEnabled: false, voiceEnabled: false }))
      .not.toContain(SEND_VOICE_TOOL);
  });

  test("语音行按 agent.tts 的 daily_limit - daily_reserve_quota 计算", () => {
    const voiceLine = (): string =>
      buildToolStatusBlock({ ctx: buildContext(), imageEnabled: false, voiceEnabled: true }).split("\n")[1]!;
    adoptTtsQuota(10, 4);
    ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 2, reserveCount: 0 };
    expect(voiceLine()).toBe(voiceToolStatus(4, 6));
    // 上限调低到已用次数以下：余量为 0。
    adoptTtsQuota(3, 2);
    expect(voiceLine()).toBe(voiceToolStatus(0, 1));
  });
});

describe("send_voice 接纳闸", () => {
  test("本轮已作废时拒绝", async () => {
    const { result } = await runVoice(buildContext({ isActive: () => false }), { text: "バカ" });
    expect(errorOf(result)).toBe(REPLY_INVALIDATED_TOOL_ERROR);
  });

  test("单轮只接纳一条", () => {
    const execute = createSendVoiceExecutor(buildContext(), recordedChains());
    expect(JSON.parse(preparedVoice(execute(JSON.stringify({ text: "バカ" }))).result).success).toBe(true);
    const second: ReplyToolExecution = execute(JSON.stringify({ text: "ざぁこ" }));
    expect(typeof second === "string" && errorOf(second)).toContain("Voice limit reached");
  });

  test("调用时同步预留额度：两轮回复抢最后一次额度，后调用的当场拿到超限错误；TTS 成功后才登记计数", async () => {
    ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 74, reserveCount: 0 };
    const first = createSendVoiceExecutor(buildContext(), recordedChains())(JSON.stringify({ text: "バカ" }));
    const second = createSendVoiceExecutor(buildContext(), recordedChains())(JSON.stringify({ text: "ざぁこ" }));

    expect(typeof second === "string" && JSON.parse(second)).toEqual({ error: SEND_VOICE_DAILY_LIMIT_TOOL_ERROR, retryable: false });
    expect(JSON.parse(preparedVoice(first).result)).toMatchObject({ success: true, voice_remaining_today: 0 });
    // 准入只占预留：持久化计数要等 TTS 调用成功才加。
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 74 });
    expect(pendingAiTtsReservations.current).toBe(1);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    await synthesizeSpeech.mock.results[0]!.value;
    await Bun.sleep(0);
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 75 });
    expect(pendingAiTtsReservations.current).toBe(0);
  });

  test("模型可见余量用尽时拒绝并要求不在群里提起，不合成", async () => {
    ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 75, reserveCount: 0 };
    const { result } = await runVoice(buildContext(), { text: "バカ" });
    expect(JSON.parse(result)).toEqual({ error: SEND_VOICE_DAILY_LIMIT_TOOL_ERROR, retryable: false });
    expect(SEND_VOICE_DAILY_LIMIT_TOOL_ERROR).toContain("do not mention the voice");
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  test("余量按配置的 AI 口径计算：daily_reserve_quota 为 0 时可用满 daily_limit", async () => {
    adoptTtsQuota(80, 0);
    ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 75, reserveCount: 0 };
    const { accepted } = await runVoice(buildContext(), { text: "バカ" });
    expect(JSON.parse(accepted)).toMatchObject({ success: true, voice_remaining_today: 4 });
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

describe("send_voice 投递", () => {
  test("调用时当场交回接纳回执、不等合成；投递步骤等合成期间亮「正在录音」，合成好后再按语音时长模拟录音才发送", async () => {
    const ctx: ReplyToolContext = buildContext();
    const events: string[] = recordEvents(ctx);
    const synthesis: PromiseWithResolvers<SpeechSynthesisAttempt> = Promise.withResolvers<SpeechSynthesisAttempt>();
    synthesizeSpeech.mockImplementationOnce((): Promise<SpeechSynthesisAttempt> => synthesis.promise);
    const chains: RecordedChains = recordedChains();

    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, chains)(
      JSON.stringify({ text: "  この雑魚♡\nバーカ ", reply_to_trigger: true })
    ));
    // 合成还没结束，回执已经交回并预占一个动作。
    expect(JSON.parse(execution.result)).toEqual({ success: true, queued: true, actions_used: 1, voice_remaining_today: 74 });
    const delivered: Promise<string> = execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction));
    expect(events).toEqual(["record_voice"]);

    events.push("synthesized");
    synthesis.resolve(spoken(sineWav(24_000, 1.2)));
    expect(JSON.parse(await delivered)).toEqual({ success: true, message_id: 77, actions_used: 1, voice_remaining_today: 74 });
    // 等合成时亮的「正在录音」不抵扣：发送前照样按语音时长模拟一段。
    expect(events).toEqual(["record_voice", "synthesized", "record_voice", "idle", "settled", "sent"]);
    expect(chains.deferred).toHaveLength(0);
    expect(synthesizeSpeech.mock.calls[0]![0]).toStrictEqual({
      text: "この雑魚♡ バーカ",
      tone: undefined,
      quota: "ai",
      signal: undefined,
    });
    const sendArgs = sendVoiceWithResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendArgs).toMatchObject({
      chatId: -1001,
      fileName: VOICE_OGG_FILE_NAME,
      replyToMessageId: 42,
      messageThreadId: 9,
      duration: 2,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe((sendArgs.duration as number) * 1_000);
    expect(new TextDecoder().decode((sendArgs.bytes as Uint8Array).subarray(0, 4))).toBe("OggS");
    expect(ctx.onVoiceSent).toHaveBeenCalledWith("（发送了一条语音：この雑魚♡ バーカ）", 77, 42);
  });

  test("补发：轮到投递步骤时语音已合成好，按语音时长重新模拟「正在录音」再发送", async () => {
    // OGG/Opus 只做容器校验、不经异步编码，合成结果在一个宏任务内落定。
    const ogg = await encodeVoiceMessage({ bytes: sineWav(24_000, 1.2), mimeType: "audio/wav" });
    if (!ogg.ok) throw new Error("expected an encodable fixture");
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> => spoken(ogg.voice.bytes, OGG_OPUS_MIME_TYPE));
    const ctx: ReplyToolContext = buildContext();
    const events: string[] = recordEvents(ctx);
    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, recordedChains())(JSON.stringify({ text: "バカ" })));
    expect(JSON.parse(execution.result).success).toBe(true);
    await Bun.sleep(0);
    expect(JSON.parse(await execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction)))).toEqual({ success: true, message_id: 77, actions_used: 1, voice_remaining_today: 74 });
    expect(events).toEqual(["record_voice", "idle", "settled", "sent"]);
    const duration: unknown = (sendVoiceWithResult.mock.calls[0]![0] as Record<string, unknown>).duration;
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe((duration as number) * 1_000);
  });

  test("前台窗口到点仍在合成：链上收回录音、转入后台；合成成功后按音频时长补录音再发送", async () => {
    jest.useFakeTimers();
    const ctx: ReplyToolContext = buildContext();
    const events: string[] = recordEvents(ctx);
    const synthesis: PromiseWithResolvers<SpeechSynthesisAttempt> = Promise.withResolvers<SpeechSynthesisAttempt>();
    synthesizeSpeech.mockImplementationOnce((): Promise<SpeechSynthesisAttempt> => synthesis.promise);
    const chains: RecordedChains = recordedChains();

    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, chains)(JSON.stringify({ text: "バカ" })));
    expect(JSON.parse(execution.result)).toEqual({ success: true, queued: true, actions_used: 1, voice_remaining_today: 74 });
    const step: Promise<string> = execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction));
    jest.advanceTimersByTime(VOICE_FOREGROUND_WAIT_MS - 1);
    expect(events).toEqual(["record_voice"]);
    jest.advanceTimersByTime(1);

    expect(JSON.parse(await step)).toEqual({ synthesis: "background" });
    expect(events).toEqual(["record_voice", "idle"]);
    expect(chains.deferred).toHaveLength(1);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();

    jest.useRealTimers();
    synthesis.resolve(spoken(sineWav(24_000, 1.2)));
    const late: ReplyActionRun | null = await chains.deferred[0]!;
    if (late === null) throw new Error("expected a background delivery");
    expect(JSON.parse(await late(ctx.chatAction, createSimulatedPause(ctx.chatAction)))).toEqual({ success: true, message_id: 77, actions_used: 1, voice_remaining_today: 74 });
    expect(events).toEqual(["record_voice", "idle", "record_voice", "idle", "settled", "sent"]);
    const duration: unknown = (sendVoiceWithResult.mock.calls[0]![0] as Record<string, unknown>).duration;
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe((duration as number) * 1_000);
    expect(ctx.onVoiceSent).toHaveBeenCalledWith("（发送了一条语音：バカ）", 77, 42);
  });

  test("转入后台后合成失败：只记日志，不投递、不自录、不计数", async () => {
    jest.useFakeTimers();
    const ctx: ReplyToolContext = buildContext();
    const synthesis: PromiseWithResolvers<SpeechSynthesisAttempt> = Promise.withResolvers<SpeechSynthesisAttempt>();
    synthesizeSpeech.mockImplementationOnce((): Promise<SpeechSynthesisAttempt> => synthesis.promise);
    const chains: RecordedChains = recordedChains();

    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, chains)(JSON.stringify({ text: "バカ" })));
    const step: Promise<string> = execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction));
    jest.advanceTimersByTime(VOICE_FOREGROUND_WAIT_MS);
    expect(JSON.parse(await step)).toEqual({ synthesis: "background" });

    synthesis.resolve({ ok: false, reason: "synthesis failed" });
    expect(await chains.deferred[0]!).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("AI reply voice was not sent (chat -1001): synthesis failed.");
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(ctx.onVoiceSent).not.toHaveBeenCalled();
    expect(ttsDailyUsage.current).toBeNull();
    expect(pendingAiTtsReservations.current).toBe(0);
  });

  test("链在窗口到点后才轮到：合成仍未结束时不亮录音、直接转入后台", async () => {
    jest.useFakeTimers();
    const ctx: ReplyToolContext = buildContext();
    const events: string[] = recordEvents(ctx);
    const synthesis: PromiseWithResolvers<SpeechSynthesisAttempt> = Promise.withResolvers<SpeechSynthesisAttempt>();
    synthesizeSpeech.mockImplementationOnce((): Promise<SpeechSynthesisAttempt> => synthesis.promise);
    const chains: RecordedChains = recordedChains();

    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, chains)(JSON.stringify({ text: "バカ" })));
    jest.advanceTimersByTime(VOICE_FOREGROUND_WAIT_MS);
    expect(JSON.parse(await execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction)))).toEqual({ synthesis: "background" });
    expect(events).toEqual([]);
    expect(chains.deferred).toHaveLength(1);
    synthesis.resolve({ ok: false, reason: "synthesis failed" });
    expect(await chains.deferred[0]!).toBeNull();
  });

  test("链在窗口到点后才轮到：合成已在窗口之后成功时就地按音频时长补录音再发送", async () => {
    // OGG/Opus 只做容器校验、不经异步编码，合成结果在一个宏任务内落定。
    const ogg = await encodeVoiceMessage({ bytes: sineWav(24_000, 1.2), mimeType: "audio/wav" });
    if (!ogg.ok) throw new Error("expected an encodable fixture");
    jest.useFakeTimers();
    const ctx: ReplyToolContext = buildContext();
    const events: string[] = recordEvents(ctx);
    const synthesis: PromiseWithResolvers<SpeechSynthesisAttempt> = Promise.withResolvers<SpeechSynthesisAttempt>();
    synthesizeSpeech.mockImplementationOnce((): Promise<SpeechSynthesisAttempt> => synthesis.promise);
    const chains: RecordedChains = recordedChains();

    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, chains)(JSON.stringify({ text: "バカ" })));
    jest.advanceTimersByTime(VOICE_FOREGROUND_WAIT_MS);
    jest.useRealTimers();
    synthesis.resolve(spoken(ogg.voice.bytes, OGG_OPUS_MIME_TYPE));
    await Bun.sleep(0);

    expect(JSON.parse(await execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction)))).toEqual({ success: true, message_id: 77, actions_used: 1, voice_remaining_today: 74 });
    expect(events).toEqual(["record_voice", "idle", "settled", "sent"]);
    expect(chains.deferred).toHaveLength(0);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(ogg.voice.durationSeconds * 1_000);
  });

  test("tone 清洗成单行后随台词交给合成；null 与空白按未给出处理", async () => {
    await runVoice(buildContext(), { text: "バカ", tone: " 鼻で笑うように\n小声で " });
    expect(synthesizeSpeech.mock.calls[0]![0]).toStrictEqual({
      text: "バカ",
      tone: "鼻で笑うように 小声で",
      quota: "ai",
      signal: undefined,
    });

    for (const tone of [null, "   "]) {
      synthesizeSpeech.mockClear();
      await runVoice(buildContext(), { text: "バカ", tone });
      expect(synthesizeSpeech.mock.calls[0]![0]).toStrictEqual({ text: "バカ", tone: undefined, quota: "ai", signal: undefined });
    }
  });

  test("未要求挂回复时不带回复目标", async () => {
    await runVoice(buildContext(), { text: "バカ" });
    expect((sendVoiceWithResult.mock.calls[0]![0] as Record<string, unknown>).replyToMessageId).toBeUndefined();
  });

  test("TTS 失败时不计数；TTS 成功而音频不可编码时照常计数；两种都只记日志、不发送、不自录", async () => {
    const ctx: ReplyToolContext = buildContext();
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> => ({ ok: false, reason: "synthesis failed" }));
    const failed = await runVoice(ctx, { text: "バカ" });
    expect(JSON.parse(failed.accepted)).toMatchObject({ success: true, queued: true, actions_used: 1 });
    expect(JSON.parse(failed.result)).toEqual({ synthesis: "failed" });
    expect(loggerError).toHaveBeenCalledWith("AI reply voice was not sent (chat -1001): synthesis failed.");
    expect(ttsDailyUsage.current).toBeNull();
    expect(pendingAiTtsReservations.current).toBe(0);

    synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> => spoken(new Uint8Array([1, 2, 3]), "audio/mp3"));
    expect(JSON.parse((await runVoice(ctx, { text: "バカ" })).result)).toEqual({ synthesis: "failed" });
    expect(loggerError).toHaveBeenCalledWith("Voice message encoding failed (chat -1001): unsupported speech mime type.");
    expect(loggerError).toHaveBeenCalledWith("AI reply voice was not sent (chat -1001): unsupported speech mime type.");
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 1 });
    expect(pendingAiTtsReservations.current).toBe(0);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(ctx.onVoiceSent).not.toHaveBeenCalled();
  });

  test("合成意外抛错时记英文日志并按合成失败结算：投递步骤不发送", async () => {
    const ctx: ReplyToolContext = buildContext();
    const failure: Error = new Error("provider exploded");
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> => {
      throw failure;
    });
    const { accepted, result } = await runVoice(ctx, { text: "バカ" });
    expect(JSON.parse(accepted).success).toBe(true);
    expect(JSON.parse(result)).toEqual({ synthesis: "failed" });
    expect(loggerError).toHaveBeenCalledWith("Voice synthesis failed unexpectedly (chat -1001):", failure);
    expect(loggerError).toHaveBeenCalledWith("AI reply voice was not sent (chat -1001): synthesis failed.");
    expect(ttsDailyUsage.current).toBeNull();
    expect(pendingAiTtsReservations.current).toBe(0);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
  });

  test("合成期间本轮作废时不发送、不记失败日志", async () => {
    let active: boolean = true;
    const ctx: ReplyToolContext = buildContext({ isActive: () => active });
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> => {
      active = false;
      return spoken(sineWav(24_000, 0.5));
    });
    const { result } = await runVoice(ctx, { text: "バカ" });
    expect(errorOf(result)).toBe(REPLY_INVALIDATED_TOOL_ERROR);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("合成完成后、投递前作废时投递步骤直接返回作废错误", async () => {
    let active: boolean = true;
    const ctx: ReplyToolContext = buildContext({ isActive: () => active });
    const execution: PreparedReplyAction = preparedVoice(createSendVoiceExecutor(ctx, recordedChains())(JSON.stringify({ text: "バカ" })));
    expect(JSON.parse(execution.result).success).toBe(true);
    active = false;
    expect(errorOf(await execution.run(ctx.chatAction, createSimulatedPause(ctx.chatAction)))).toBe(REPLY_INVALIDATED_TOOL_ERROR);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
  });

  test("发送失败返回不可重试错误且不自录", async () => {
    const ctx: ReplyToolContext = buildContext();
    sendVoiceWithResult.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => undefined);
    const { result } = await runVoice(ctx, { text: "バカ" });
    expect(JSON.parse(result)).toEqual({ error: "Failed to send voice message", retryable: false });
    expect(ctx.onVoiceSent).not.toHaveBeenCalled();
  });
});
