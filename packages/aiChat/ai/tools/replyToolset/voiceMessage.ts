/**
 * send_voice：把模型写的一句日语台词按可选的本句语气（tone）合成语音，转成 Telegram
 * 语音格式（OGG/Opus 或 MP3，见 aiChat/ai/voiceEncoding.ts）后以语音消息发送到当前群。
 *
 * 工具声明逐字恒定，只要 `agent.tts` 配置且实现具备语音合成就挂载；调用与否由
 * 模型按工具说明（SEND_VOICE_TOOL_INSTRUCTION）与本轮工具状态里的余量行
 * （见 toolStatus.ts）判断，执行侧不另设按轮资格。
 *
 * 执行分三段，直接轮与有序并行轮相同：
 * - 准入（调用时同步）：本轮有效性、单轮限额、实现能力、参数校验，最后按 `ai` 口径
 *   预留一次每日额度（reserveAiTtsUsage），已登记加在途预留达到上限时当场回
 *   SEND_VOICE_DAILY_LIMIT_TOOL_ERROR。通过后当场交回接纳回执（带预留后的今日余量）并预占一个
 *   共享动作，模型不等合成。
 * - 生产（调用时在后台开始）：经公共实现（aiChat/ai/voiceSynthesis.ts）合成并编码，与模型
 *   后续请求及串行链上排在前面的步骤并行；前台窗口 VOICE_FOREGROUND_WAIT_MS 从调用起算。
 *   TTS 调用成功时才登记每日计数，失败、在成功前被取消或意外异常时只释放预留
 *   （settleAiTtsReservation）；TTS 成功后编码失败、发送失败或取消都不退回。
 * - 投递（串行动作链，调用时按顺序排入）：轮到这一步时合成未结束且窗口未到点，就亮
 *   「正在录音」等它。窗口到点仍未结束时收回「正在录音」，投递转入后台（chains.defer），链继续
 *   执行后续步骤；后台合成成功后投递排到链尾补发。合成失败（含超时与音频不可用）时不投递，
 *   只记英文日志，模型不会得知。
 *
 * 每条语音发送前都按语音时长模拟「正在录音」，与之前等合成亮过多久无关；随后切 idle、等状态
 * 收敛后发送，落地后按同一消息登记语音自录记号。
 * 工具声明、参数口径、单轮限额与挂回复只属于本工具。
 */

import type { AiMeteredSpeechRequest, AiToolDefinition } from "../../../../types/aiChat/provider";
import { SEND_VOICE_TOOL_INSTRUCTION } from "../../../../consts/aiChat/prompts/tools";
import { voiceSentTagTemplate } from "../../../../consts/aiChat/prompts/transcript";
import {
  MAX_VOICES_PER_REPLY,
  VOICE_FOREGROUND_WAIT_MS,
  VOICE_TEXT_MAX_CHARS,
  VOICE_TONE_MAX_CHARS,
} from "../../../../consts/aiChat/voiceMessage";
import {
  REPLY_INVALIDATED_TOOL_ERROR,
  SEND_VOICE_DAILY_LIMIT_TOOL_ERROR,
  SEND_VOICE_TOOL,
} from "../../../../consts/tools";
import { agentTtsConfig } from "../../../../config/agent";
import { logger } from "../../../../infra/logger";
import { sendVoiceWithResult } from "../../../../infra/telegram";
import { sanitizeInline } from "../../../../libs/text";
import { ttsAiProvider } from "../../../provider";
import { aiTtsRemaining, reserveAiTtsUsage, settleAiTtsReservation } from "../../ttsUsage";
import { ttsQuotaLimit } from "../../utils/ttsUsageWindow";
import { resolveSpeechSynthesizer, synthesizeVoiceMessage } from "../../voiceSynthesis";
import { parseToolArguments } from "../../utils/toolArgs";
import { toolError } from "../../utils/toolResult";
import { pauseThenSettle } from "./pacing";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  ReplyActionChains,
  ReplyActionPause,
  ReplyActionRun,
  ReplyToolContext,
  ReplyToolExecution,
} from "../../../../types/aiChat/replies";
import type {
  EncodedVoiceMessage,
  SpeechSynthesisAttempt,
  SpeechSynthesizer,
  SpeechSynthesizerLookup,
  VoiceSynthesisResult,
} from "../../../../types/aiChat/voiceMessage";
import type { TelegramSendResult } from "../../../../types/telegram";
import type { AgentTtsCapabilityConfig } from "../../../../types/config";

/** 本轮是否挂载 send_voice：`agent.tts` 已配置且所选实现具备语音合成。 */
export function isSendVoiceAvailable(): boolean {
  return ttsAiProvider()?.synthesizeSpeech !== undefined;
}

/** send_voice 的工具声明；整段逐字恒定，不接受任何本轮上下文。 */
export function buildSendVoiceToolDefinition(): AiToolDefinition {
  return {
    name: SEND_VOICE_TOOL,
    description: SEND_VOICE_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          maxLength: VOICE_TEXT_MAX_CHARS,
          description: `要念出来的日语台词原文，一两句，不超过 ${VOICE_TEXT_MAX_CHARS} 字。`,
        },
        tone: {
          type: "string",
          maxLength: VOICE_TONE_MAX_CHARS,
          description:
            `这一句的说话语气，用日语简短描述怎么说（如「鼻で笑うように」「呆れたようにため息まじりで」），不超过 ${VOICE_TONE_MAX_CHARS} 字；` +
            "会追加在固定的基础声线描述之后，只影响这一句。省略则只用基础声线。",
        },
        reply_to_trigger: {
          type: "boolean",
          description: "是否以「回复」形式挂在触发你这次回复的那条消息上；省略视为 false。",
        },
      },
      required: ["text"],
    },
  };
}

/** 解析后的语音入参；tone 缺省、为 null 或清洗后为空时是 undefined。 */
interface ParsedVoiceArguments {
  text: string;
  tone: string | undefined;
  replyToTrigger: boolean;
}

function parseArguments(argumentsJson: string): ParsedVoiceArguments | null {
  const parsed: Record<string, unknown> | null = parseToolArguments(argumentsJson);
  if (parsed === null || typeof parsed.text !== "string") return null;
  const text: string = sanitizeInline(parsed.text).trim();
  if (!text || text.length > VOICE_TEXT_MAX_CHARS) return null;
  const rawTone: unknown = parsed.tone;
  if (rawTone !== undefined && rawTone !== null && typeof rawTone !== "string") return null;
  const tone: string = typeof rawTone === "string" ? sanitizeInline(rawTone).trim() : "";
  if (tone.length > VOICE_TONE_MAX_CHARS) return null;
  const replyToTrigger: unknown = parsed.reply_to_trigger;
  if (replyToTrigger !== undefined && replyToTrigger !== null && typeof replyToTrigger !== "boolean") return null;
  return { text, tone: tone || undefined, replyToTrigger: replyToTrigger === true };
}

/** 串行链与后台投递共同读写的一次语音生产状态。 */
interface VoiceProduction {
  /** 合成与编码；不 reject：意外异常记日志并按合成失败结算。 */
  readonly result: Promise<VoiceSynthesisResult>;
  /** 前台窗口：合成结果，或窗口到点仍未结束时的 null。 */
  readonly foreground: Promise<VoiceSynthesisResult | null>;
  /** 合成已结束时的结果；未结束为 null。 */
  settled: VoiceSynthesisResult | null;
  /** 前台窗口已到点且合成当时仍未结束。 */
  windowClosed: boolean;
}

/**
 * 包住一次 TTS 调用：调用结束时恰好结清一次准入时的预留——成功时登记每日计数，失败、取消或抛错
 * 时只释放；之后的编码失败不影响计数。
 */
function settlingReservation(synthesize: SpeechSynthesizer): SpeechSynthesizer {
  return async (request: AiMeteredSpeechRequest): Promise<SpeechSynthesisAttempt> => {
    let attempt: SpeechSynthesisAttempt;
    try {
      attempt = await synthesize(request);
    } catch (error: unknown) {
      settleAiTtsReservation(false);
      throw error;
    }
    settleAiTtsReservation(attempt.ok);
    return attempt;
  };
}

/** 开始合成并挂上前台窗口；窗口计时器不阻止进程退出，合成先结束时清掉。 */
function startVoiceProduction(
  ctx: ReplyToolContext,
  synthesize: SpeechSynthesizer,
  parsed: ParsedVoiceArguments
): VoiceProduction {
  // 这份结果脱离工具调用被窗口计时、串行链与后台投递分别等待；synthesizeVoiceMessage 不抛错。
  const result: Promise<VoiceSynthesisResult> = synthesizeVoiceMessage(
    settlingReservation(synthesize),
    { text: parsed.text, tone: parsed.tone, quota: "ai", signal: ctx.signal },
    `chat ${ctx.chatId}`
  );
  const { promise: foreground, resolve }: PromiseWithResolvers<VoiceSynthesisResult | null> =
    Promise.withResolvers<VoiceSynthesisResult | null>();
  const production: VoiceProduction = { result, foreground, settled: null, windowClosed: false };
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    production.windowClosed = true;
    resolve(null);
  }, VOICE_FOREGROUND_WAIT_MS);
  timer.unref();
  void result.then((settled: VoiceSynthesisResult): void => {
    clearTimeout(timer);
    production.settled = settled;
    resolve(settled);
  });
  return production;
}

/** 一次已接纳语音的生产状态与投递所需上下文，直接轮与有序并行轮共用。 */
interface AcceptedVoice {
  readonly ctx: ReplyToolContext;
  readonly chains: ReplyActionChains;
  readonly parsed: ParsedVoiceArguments;
  readonly production: VoiceProduction;
}

/**
 * 发送已编码语音的执行步骤：先按语音时长模拟「正在录音」，再发送；与之前等合成亮过多久无关。成功
 * 结果带登记后的今日余量。
 */
function voiceDelivery(accepted: AcceptedVoice, voice: EncodedVoiceMessage): ReplyActionRun {
  const { ctx, parsed }: AcceptedVoice = accepted;
  return async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    const blocked: string | null = await pauseThenSettle({
      isActive: ctx.isActive,
      chatAction,
      pause,
      phase: "record_voice",
      delayMs: voice.durationSeconds * 1_000,
    });
    if (blocked !== null) return blocked;
    const sent: TelegramSendResult | undefined = await sendVoiceWithResult({
      chatId: ctx.chatId,
      bytes: voice.bytes,
      fileName: voice.fileName,
      replyToMessageId: parsed.replyToTrigger ? ctx.replyToMessageId : undefined,
      signal: ctx.signal,
      duration: voice.durationSeconds,
      messageThreadId: ctx.messageThreadId,
    });
    if (sent === undefined) return toolError("Failed to send voice message", { retryable: false });
    ctx.onVoiceSent(voiceSentTagTemplate(parsed.text), sent.messageId, sent.repliedToMessageId);
    return JSON.stringify({ success: true, message_id: sent.messageId, actions_used: 1, voice_remaining_today: aiTtsRemaining() });
  };
}

/** 接纳回执：带预留后的今日余量并预占一个动作。 */
function acceptanceReceipt(): string {
  return JSON.stringify({
    success: true,
    queued: true,
    actions_used: 1,
    voice_remaining_today: aiTtsRemaining(),
  });
}

/** 合成没有得到可发送的语音：只记英文日志、不投递；本轮已作废（含取消）时静默。 */
function reportVoiceNotSent(ctx: ReplyToolContext, reason: string): void {
  if (ctx.isActive()) logger.error(`AI reply voice was not sent (chat ${ctx.chatId}): ${reason}.`);
}

/** 窗口到点后转入后台：合成成功且本轮仍有效时排到链尾补发，失败只记日志。 */
function deferVoiceDelivery(accepted: AcceptedVoice): void {
  const { ctx, chains, production }: AcceptedVoice = accepted;
  chains.defer(SEND_VOICE_TOOL, production.result.then((late: VoiceSynthesisResult): ReplyActionRun | null => {
    if (!late.ok) {
      reportVoiceNotSent(ctx, late.reason);
      return null;
    }
    return ctx.isActive() ? voiceDelivery(accepted, late.voice) : null;
  }));
}

/**
 * 串行链上的投递步骤：合成还在进行且窗口未到点时亮「正在录音」等它；窗口到点仍在合成就收回录音
 * 状态、转入后台，链继续执行后续步骤；合成失败只记日志、不投递、不计动作。
 */
function voiceStep(accepted: AcceptedVoice): ReplyActionRun {
  const { ctx, production }: AcceptedVoice = accepted;
  return async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    const waiting: boolean = production.settled === null && !production.windowClosed;
    if (waiting) chatAction.set("record_voice");
    const outcome: VoiceSynthesisResult | null = waiting ? await production.foreground : production.settled;
    if (outcome === null) {
      if (waiting) chatAction.set("idle");
      deferVoiceDelivery(accepted);
      return JSON.stringify({ synthesis: "background" });
    }
    if (!outcome.ok) {
      reportVoiceNotSent(ctx, outcome.reason);
      return JSON.stringify({ synthesis: "failed" });
    }
    return voiceDelivery(accepted, outcome.voice)(chatAction, pause);
  };
}

/**
 * 语音执行器：准入在调用时同步完成，通过后在后台开始合成，当场交回接纳回执；投递步骤交串行链
 * 执行，模型不等合成。
 */
export function createSendVoiceExecutor(
  ctx: ReplyToolContext,
  chains: ReplyActionChains
): (argumentsJson: string) => ReplyToolExecution {
  let acceptedVoices: number = 0;
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (acceptedVoices >= MAX_VOICES_PER_REPLY) {
      return toolError(
        `Voice limit reached: at most ${MAX_VOICES_PER_REPLY} voice message per reply`,
        { retryable: false }
      );
    }
    const synthesizer: SpeechSynthesizerLookup = resolveSpeechSynthesizer();
    if (!synthesizer.ok) {
      return toolError(
        `Voice is unavailable: the ${synthesizer.providerName ?? "unconfigured"} provider does not support speech synthesis`,
        { retryable: false }
      );
    }
    const parsed: ParsedVoiceArguments | null = parseArguments(argumentsJson);
    if (!parsed) {
      return toolError(
        `Invalid voice arguments: text must be a non-empty string of at most ${VOICE_TEXT_MAX_CHARS} characters, ` +
        `tone must be a string of at most ${VOICE_TONE_MAX_CHARS} characters, and reply_to_trigger must be a boolean`
      );
    }
    const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
    if (tts === undefined || !reserveAiTtsUsage(ttsQuotaLimit(tts, "ai"))) {
      return toolError(SEND_VOICE_DAILY_LIMIT_TOOL_ERROR, { retryable: false });
    }
    acceptedVoices++;
    const accepted: AcceptedVoice = {
      ctx,
      chains,
      parsed,
      production: startVoiceProduction(ctx, synthesizer.synthesize, parsed),
    };
    return { result: acceptanceReceipt(), run: voiceStep(accepted) };
  };
}
