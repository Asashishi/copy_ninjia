/**
 * send_voice 的每日额度预留经真实 tts 门面与配额执行器结清：准入时按 `ai` 口径预留一次；TTS 调用
 * 成功时登记 agentCount 并回传 ttsUsage 事件；供应商没交回音频、本地配额队列拒收、本轮在 TTS 排队
 * 或在途时作废，都只释放预留、不计数；TTS 成功之后本轮才作废时计数照常保留，投递步骤不发送。
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { waitUntil } from "../../helpers/waitUntil";
import { sineWav } from "../../helpers/wav";
import type { AgentTtsCapabilityConfig } from "../../../packages/types/config";
import type { AiChatProvider, AiSpeechRequest } from "../../../packages/types/aiChat/provider";
import type { AiProviderQuotaLane } from "../../../packages/types/aiChat/providerScheduler";
import type {
  PreparedReplyAction,
  ReplyActionChains,
  ReplyToolContext,
  ReplyToolExecution,
} from "../../../packages/types/aiChat/replies";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";
import type { TelegramSendResult } from "../../../packages/types/telegram";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

const sendVoiceWithResult = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: 77,
  repliedToMessageId: undefined,
}));
const loggerError = mock((..._args: unknown[]): void => {});

const realTelegram = await import("../../../packages/infra/telegram");
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendVoiceWithResult }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
// 投递前按音频时长补「正在录音」的停顿不真的等。
mock.module("../../../packages/libs/sleep", () => ({ sleep: async (): Promise<void> => {} }));

const { createSendVoiceExecutor } = await import("../../../packages/aiChat/ai/tools/replyToolset/voiceMessage");
const { VOICE_LANGUAGE_PROMPTS } = await import("../../../packages/consts/aiChat/prompts/tools");
const { TTS_DEFAULT_BOT_LANGUAGE } = await import("../../../packages/consts/aiChat/voiceMessage");
const { createSimulatedPause } = await import("../../../packages/aiChat/ai/tools/replyToolset/pacing");
const { aiTtsRemaining } = await import("../../../packages/aiChat/ai/ttsUsage");
const { ttsQuotaLimit } = await import("../../../packages/aiChat/ai/utils/ttsUsageWindow");
const { ttsAiProvider } = await import("../../../packages/aiChat/provider");
const { geminiProvider } = await import("../../../packages/aiChat/gemini");
const { openAiProvider } = await import("../../../packages/aiChat/openai");
const { agentTtsConfig } = await import("../../../packages/config/agent");
const { aiProviderQuotaLanes, resetAiProviderSchedulerCache } =
  await import("../../../packages/cache/workers/aiChat/providerScheduler");
const { pendingAiTtsReservations, ttsDailyUsage } = await import("../../../packages/cache/workers/aiChat/ttsUsage");
const { AI_PROVIDER_MAX_CONCURRENT, AI_PROVIDER_MAX_PENDING } = await import("../../../packages/consts/aiChat/provider");
const { REPLY_INVALIDATED_TOOL_ERROR } = await import("../../../packages/consts/tools");

/** preload 接管的 config_example `agent.tts`；本文件的额度与配额 lane 都按它计算。 */
function requireTtsConfig(): AgentTtsCapabilityConfig {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  if (tts === undefined) throw new Error("config_example agent.tts must be configured for this test");
  return tts;
}

const TTS_CONFIG: AgentTtsCapabilityConfig = requireTtsConfig();
const AI_LIMIT: number = ttsQuotaLimit(TTS_CONFIG, "ai");
const CHAT_ID: number = -1003;
const SPEECH_PROVIDER: AiChatProvider = TTS_CONFIG.provider === "google" ? geminiProvider : openAiProvider;
// 门面在构造时取走实现包的 synthesizeSpeech：必须先装替身，再由 beforeEach 重建门面。
const synthesizeSpeech: Mock<NonNullable<AiChatProvider["synthesizeSpeech"]>> =
  spyOn(SPEECH_PROVIDER, "synthesizeSpeech");

function spokenWav(): SynthesizedSpeech {
  return { bytes: sineWav(24_000, 0.5), mimeType: "audio/wav" };
}

/** 一轮可作废的回复：isActive 与 signal 同源，与 replyRound.ts 的判定一致。 */
interface VoidableRound {
  readonly ctx: ReplyToolContext;
  readonly controller: AbortController;
}

function buildRound(): VoidableRound {
  const controller: AbortController = new AbortController();
  const ctx: ReplyToolContext = {
    chatId: CHAT_ID,
    replyToMessageId: 5,
    messageThreadId: undefined,
    mediaToolsRequested: false,
    bypassMediaToolCooldown: false,
    direct: true,
    chatAction: {
      set: mock((..._args: unknown[]): number => 0),
      settle: mock(async (): Promise<void> => {}),
    },
    roundHasTypo: false,
    isActive: (): boolean => !controller.signal.aborted,
    signal: controller.signal,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onVoiceSent: mock((..._args: unknown[]): void => {}),
  };
  return { ctx, controller };
}

/** 本文件的合成都在前台窗口内结束：投递步骤由执行器交回，执行器既不排链也不转入后台。 */
function idleChains(): ReplyActionChains {
  return {
    start: (): void => {
      throw new Error("send_voice must hand its delivery step back instead of starting it");
    },
    defer: (): void => {
      throw new Error("send_voice must not defer within the foreground window");
    },
    settle: async (): Promise<void> => {},
    completed: (): number => 0,
  };
}

/** 调用一次 send_voice 并要求准入通过，交回回执与投递步骤。 */
function admitVoice(ctx: ReplyToolContext): PreparedReplyAction {
  const execution: ReplyToolExecution = createSendVoiceExecutor(ctx, idleChains(), VOICE_LANGUAGE_PROMPTS[TTS_DEFAULT_BOT_LANGUAGE].speechLanguageStyle)(JSON.stringify({ text: "バカ" }));
  if (typeof execution === "string") throw new Error(`expected an accepted voice, got ${execution}`);
  return execution;
}

function runStep(ctx: ReplyToolContext, prepared: PreparedReplyAction): Promise<string> {
  return prepared.run(ctx.chatAction, createSimulatedPause(ctx.chatAction));
}

function errorOf(result: string): string | undefined {
  return (JSON.parse(result) as { error?: string }).error;
}

/** 占住 tts 配额 lane 的一批任务；release 放行并等它们全部结算，之后才能重建 lane。 */
interface LaneOccupation {
  readonly lane: AiProviderQuotaLane;
  readonly release: () => Promise<void>;
}

/** 构造 tts 门面并往它所属的配额 lane 里塞 count 个一直挂起的任务。 */
function occupyTtsLane(count: number): LaneOccupation {
  if (ttsAiProvider()?.synthesizeSpeech === undefined) throw new Error("tts facade must be able to synthesize");
  const lane: AiProviderQuotaLane | undefined = aiProviderQuotaLanes.find((candidate: AiProviderQuotaLane): boolean =>
    candidate.provider === TTS_CONFIG.provider &&
    candidate.baseUrl === TTS_CONFIG.baseUrl &&
    candidate.apiKey === TTS_CONFIG.apiKey);
  if (lane === undefined) throw new Error("tts facade must register its quota lane");
  const blocker: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const occupying: Promise<void | undefined>[] = [];
  for (let index: number = 0; index < count; index++) {
    occupying.push(lane.runner.run("interactive", (): Promise<void> => blocker.promise));
  }
  return {
    lane,
    release: async (): Promise<void> => {
      blocker.resolve();
      await Promise.allSettled(occupying);
    },
  };
}

beforeEach(() => {
  resetAiProviderSchedulerCache();
  ttsDailyUsage.current = null;
  pendingAiTtsReservations.current = 0;
  postMessage.mockClear();
  loggerError.mockClear();
  sendVoiceWithResult.mockClear();
  synthesizeSpeech.mockClear();
  synthesizeSpeech.mockImplementation(async (): Promise<SynthesizedSpeech | null> => spokenWav());
});

afterAll(() => {
  synthesizeSpeech.mockRestore();
  resetAiProviderSchedulerCache();
  ttsDailyUsage.current = null;
  pendingAiTtsReservations.current = 0;
  if (originalSelfDescriptor === undefined) Reflect.deleteProperty(globalThis, "self");
  else Object.defineProperty(globalThis, "self", originalSelfDescriptor);
});

describe("send_voice 预留经 tts 门面结清", () => {
  test("TTS 成功：准入只占预留，合成成功时登记 agentCount、回传 ttsUsage 并结清预留", async () => {
    const synthesis: PromiseWithResolvers<SynthesizedSpeech | null> = Promise.withResolvers<SynthesizedSpeech | null>();
    synthesizeSpeech.mockImplementation((): Promise<SynthesizedSpeech | null> => synthesis.promise);
    const { ctx }: VoidableRound = buildRound();

    const prepared: PreparedReplyAction = admitVoice(ctx);
    expect(JSON.parse(prepared.result)).toEqual({
      success: true,
      queued: true,
      actions_used: 1,
      voice_remaining_today: AI_LIMIT - 1,
    });
    expect(pendingAiTtsReservations.current).toBe(1);
    await waitUntil((): boolean => synthesizeSpeech.mock.calls.length === 1);
    const request: AiSpeechRequest = synthesizeSpeech.mock.calls[0]![0];
    expect(request).toMatchObject({ text: "バカ", quota: "ai" });
    expect(request.signal).toBe(ctx.signal);
    // TTS 还没结束：持久化计数不动，也不回传。
    expect(ttsDailyUsage.current).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();

    synthesis.resolve(spokenWav());
    expect(JSON.parse(await runStep(ctx, prepared))).toEqual({
      success: true,
      message_id: 77,
      actions_used: 1,
      voice_remaining_today: AI_LIMIT - 1,
    });
    expect(pendingAiTtsReservations.current).toBe(0);
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 1, reserveCount: 0 });
    expect(postMessage.mock.calls).toEqual([[{ type: "ttsUsage", usage: ttsDailyUsage.current }]]);
    expect(aiTtsRemaining()).toBe(AI_LIMIT - 1);
    expect(sendVoiceWithResult).toHaveBeenCalledTimes(1);
  });

  test("供应商没交回音频（门面归一成合成失败）：只释放预留，不计数、不回传、不发送", async () => {
    synthesizeSpeech.mockImplementation(async (): Promise<SynthesizedSpeech | null> => null);
    const { ctx }: VoidableRound = buildRound();

    const prepared: PreparedReplyAction = admitVoice(ctx);
    expect(pendingAiTtsReservations.current).toBe(1);

    expect(JSON.parse(await runStep(ctx, prepared))).toEqual({ synthesis: "failed" });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(pendingAiTtsReservations.current).toBe(0);
    expect(ttsDailyUsage.current).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
    expect(aiTtsRemaining()).toBe(AI_LIMIT);
    expect(loggerError).toHaveBeenCalledWith(`AI reply voice was not sent (chat ${CHAT_ID}): synthesis failed.`);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
  });

  test("本地配额队列已满、执行器交回 undefined：不发起供应商请求，只释放预留、不计数", async () => {
    const occupation: LaneOccupation = occupyTtsLane(AI_PROVIDER_MAX_CONCURRENT + AI_PROVIDER_MAX_PENDING);
    try {
      expect(occupation.lane.runner.activeCount).toBe(AI_PROVIDER_MAX_CONCURRENT);
      expect(occupation.lane.runner.pendingCount).toBe(AI_PROVIDER_MAX_PENDING);
      const { ctx }: VoidableRound = buildRound();

      const prepared: PreparedReplyAction = admitVoice(ctx);
      expect(pendingAiTtsReservations.current).toBe(1);

      expect(JSON.parse(await runStep(ctx, prepared))).toEqual({ synthesis: "failed" });
      expect(pendingAiTtsReservations.current).toBe(0);
      expect(ttsDailyUsage.current).toBeNull();
      expect(postMessage).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(`AI reply voice was not sent (chat ${CHAT_ID}): synthesis failed.`);
    } finally {
      await occupation.release();
    }
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
  });

  test("TTS 在配额队列里排队时本轮作废：排队项被撤下，不发起供应商请求，只释放预留、不计数", async () => {
    const occupation: LaneOccupation = occupyTtsLane(AI_PROVIDER_MAX_CONCURRENT);
    try {
      const { ctx, controller }: VoidableRound = buildRound();
      const prepared: PreparedReplyAction = admitVoice(ctx);
      expect(occupation.lane.runner.pendingCount).toBe(1);
      expect(pendingAiTtsReservations.current).toBe(1);

      controller.abort();
      await waitUntil((): boolean => pendingAiTtsReservations.current === 0);

      expect(pendingAiTtsReservations.current).toBe(0);
      expect(occupation.lane.runner.pendingCount).toBe(0);
      expect(ttsDailyUsage.current).toBeNull();
      expect(postMessage).not.toHaveBeenCalled();
      expect(errorOf(await runStep(ctx, prepared))).toBe(REPLY_INVALIDATED_TOOL_ERROR);
    } finally {
      await occupation.release();
    }
    // 占位任务放行后，撤下的排队项也不会再被拉起。
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("TTS 请求在途时本轮作废：供应商按取消交回空结果，只释放预留、不计数、不记失败日志", async () => {
    // 两家实现在调用方取消时都返回 null、不记错误（见 aiChat/ai/utils/speechPayload.ts 的 speechRequestFailed）。
    synthesizeSpeech.mockImplementation((request: AiSpeechRequest): Promise<SynthesizedSpeech | null> =>
      new Promise<SynthesizedSpeech | null>((resolve: (speech: SynthesizedSpeech | null) => void): void => {
        request.signal?.addEventListener("abort", (): void => resolve(null), { once: true });
      }));
    const { ctx, controller }: VoidableRound = buildRound();

    const prepared: PreparedReplyAction = admitVoice(ctx);
    await waitUntil((): boolean => synthesizeSpeech.mock.calls.length === 1);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(pendingAiTtsReservations.current).toBe(1);

    controller.abort();
    await waitUntil((): boolean => pendingAiTtsReservations.current === 0);

    expect(pendingAiTtsReservations.current).toBe(0);
    expect(ttsDailyUsage.current).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
    expect(aiTtsRemaining()).toBe(AI_LIMIT);
    expect(errorOf(await runStep(ctx, prepared))).toBe(REPLY_INVALIDATED_TOOL_ERROR);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("TTS 成功之后、投递之前本轮作废：计数照常保留，投递步骤返回作废错误且不发送", async () => {
    const { ctx, controller }: VoidableRound = buildRound();

    const prepared: PreparedReplyAction = admitVoice(ctx);
    await waitUntil((): boolean => pendingAiTtsReservations.current === 0);
    expect(pendingAiTtsReservations.current).toBe(0);
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 1, reserveCount: 0 });

    controller.abort();

    expect(errorOf(await runStep(ctx, prepared))).toBe(REPLY_INVALIDATED_TOOL_ERROR);
    expect(sendVoiceWithResult).not.toHaveBeenCalled();
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 1, reserveCount: 0 });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(aiTtsRemaining()).toBe(AI_LIMIT - 1);
  });
});
