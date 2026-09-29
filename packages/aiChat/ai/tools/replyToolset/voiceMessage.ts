/**
 * send_voice：把模型写的一句日语台词按可选的本句语气（tone）合成语音，转成 Telegram
 * 语音格式（OGG/Opus 或 MP3，见 aiChat/ai/voiceEncoding.ts）后以语音消息发送到当前群。
 *
 * 工具声明逐字恒定，只要 `agent.tts` 配置且实现具备语音合成就挂载；调用与否由
 * 模型按工具说明（SEND_VOICE_TOOL_INSTRUCTION）与本轮工具状态里的余量行
 * （见 toolStatus.ts）判断，执行侧不另设按轮资格。
 *
 * 回执分三段：
 * - 准入（调用时同步）：本轮有效性、单轮限额、实现能力、参数校验，最后按 `ai` 口径
 *   原子登记每日计数（claimTtsUsage），超限当场回 SEND_VOICE_DAILY_LIMIT_TOOL_ERROR。
 * - 生产（调用时开始）：经公共实现（aiChat/ai/voiceSynthesis.ts）合成并编码，与串行链上
 *   排在前面的步骤并行。工具回执最多等前台窗口 VOICE_FOREGROUND_WAIT_MS（从调用起算）：
 *   窗口内失败、超时或音频不可用回 SEND_VOICE_SYNTHESIS_FAILED_TOOL_ERROR，不占动作；
 *   窗口内成功回执带登记后的今日余量并预占一个共享动作；到点仍未结束同样预占一个动作，
 *   回执带 `synthesis: "pending"`，模型继续后续调用。
 * - 直接轮（群里没有在途轮次时启动）不排串行链：调用内等合成，期间亮「正在录音」；窗口内
 *   合成好就在调用内发出，回执是真实结果（带消息编号与今日余量）；窗口到点同样回 pending 并
 *   转入后台，下面的后台投递规则照常适用。以下投递规则针对有序并行轮。
 * - 投递（串行动作链，调用时按顺序排入）：轮到这一步时合成未结束且窗口未到点，就亮
 *   「正在录音」等它。窗口到点仍未结束时收回「正在录音」，投递转入后台（chains.defer），链继续
 *   执行后续步骤；后台合成成功后投递排到链尾补发。
 * 每条语音发送前都按语音时长模拟「正在录音」，与之前等合成亮过多久无关；随后切 idle、等状态
 * 收敛后发送，落地后按同一消息登记语音自录记号。
 * 登记后的计数不因取消、合成失败或发送失败退回。工具声明、参数口径、单轮限额与挂回复
 * 只属于本工具。
 */

import type { AiToolDefinition } from "../../../../types/aiChat/provider";
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
  SEND_VOICE_SYNTHESIS_FAILED_TOOL_ERROR,
  SEND_VOICE_TOOL,
} from "../../../../consts/tools";
import { agentTtsConfig } from "../../../../config/agent";
import { logger } from "../../../../infra/logger";
import { sendVoiceWithResult } from "../../../../infra/telegram";
import { sanitizeInline } from "../../../../libs/text";
import { ttsAiProvider } from "../../../provider";
import { aiTtsRemaining, claimTtsUsage } from "../../ttsUsage";
import { ttsQuotaLimit } from "../../utils/ttsUsageWindow";
import { resolveSpeechSynthesizer, synthesizeVoiceMessage } from "../../voiceSynthesis";
import { parseToolArguments } from "../../utils/toolArgs";
import { toolError } from "../../utils/toolResult";
import { createSimulatedPause } from "./pacing";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  ReplyActionChains,
  ReplyActionPause,
  ReplyActionRun,
  ReplyToolContext,
} from "../../../../types/aiChat/replies";
import type {
  EncodedVoiceMessage,
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

/** 开始合成并挂上前台窗口；窗口计时器不阻止进程退出，合成先结束时清掉。 */
function startVoiceProduction(
  ctx: ReplyToolContext,
  synthesize: SpeechSynthesizer,
  parsed: ParsedVoiceArguments
): VoiceProduction {
  // 这份结果脱离工具调用被窗口计时、串行链与后台投递分别等待，异常必须在这里结算。
  const result: Promise<VoiceSynthesisResult> = synthesizeVoiceMessage(
    synthesize,
    { text: parsed.text, tone: parsed.tone, quota: "ai", quotaClaimed: true, signal: ctx.signal },
    `chat ${ctx.chatId}`
  ).catch((error: unknown): VoiceSynthesisResult => {
    logger.error(`Voice synthesis failed unexpectedly (chat ${ctx.chatId}):`, error);
    return { ok: false, reason: "synthesis failed" };
  });
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
    const invalidated: string | null = await pause("record_voice", voice.durationSeconds * 1_000);
    if (invalidated !== null) return invalidated;
    chatAction.set("idle");
    await chatAction.settle();
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
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

/** 接纳回执：带登记后的今日余量并预占一个动作；synthesisPending 表示合成仍在后台进行。 */
function acceptanceReceipt(synthesisPending: boolean): string {
  return JSON.stringify({
    success: true,
    queued: true,
    actions_used: 1,
    voice_remaining_today: aiTtsRemaining(),
    ...(synthesisPending ? { synthesis: "pending" } : {}),
  });
}

/** 窗口到点后转入后台：合成成功且本轮仍有效时排到链尾补发。 */
function deferVoiceDelivery(accepted: AcceptedVoice): void {
  const { ctx, chains, production }: AcceptedVoice = accepted;
  chains.defer(SEND_VOICE_TOOL, production.result.then((late: VoiceSynthesisResult): ReplyActionRun | null =>
    late.ok && ctx.isActive() ? voiceDelivery(accepted, late.voice) : null
  ));
}

/**
 * 直接轮：调用内等合成（最多一个前台窗口），期间亮「正在录音」，合成好就在调用内发出，回真实结果
 * 并经 chains.record 记账；窗口到点回 pending 接纳回执并转入后台。收挡由工具集在调用结束时统一做
 * （见 orchestrator.ts 的 runDirect）。
 */
async function deliverVoiceDirectly(accepted: AcceptedVoice): Promise<string> {
  const { ctx, chains, production }: AcceptedVoice = accepted;
  ctx.chatAction.set("record_voice");
  const outcome: VoiceSynthesisResult | null = await production.foreground;
  if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
  if (outcome === null) {
    deferVoiceDelivery(accepted);
    return acceptanceReceipt(true);
  }
  if (!outcome.ok) return toolError(SEND_VOICE_SYNTHESIS_FAILED_TOOL_ERROR, { retryable: false });
  const delivered: string = await voiceDelivery(accepted, outcome.voice)(
    ctx.chatAction,
    createSimulatedPause(ctx.chatAction, ctx.signal)
  );
  chains.record(SEND_VOICE_TOOL, delivered);
  return delivered;
}

/** 有序并行轮：把投递步骤按调用顺序排进串行链，交回最多等前台窗口的接纳回执。 */
function queueVoiceDelivery(accepted: AcceptedVoice): Promise<string> {
  const { ctx, chains, production }: AcceptedVoice = accepted;
  chains.start(SEND_VOICE_TOOL, async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    // 合成还在进行且窗口未到点：等它，期间亮「正在录音」。
    const waiting: boolean = production.settled === null && !production.windowClosed;
    if (waiting) chatAction.set("record_voice");
    const outcome: VoiceSynthesisResult | null = waiting ? await production.foreground : production.settled;
    if (outcome === null) {
      // 窗口到点仍在合成：收回等待时亮的录音状态，投递转入后台，链继续执行后续步骤。
      if (waiting) chatAction.set("idle");
      deferVoiceDelivery(accepted);
      return JSON.stringify({ synthesis: "background" });
    }
    // 合成失败已由供应商实现与编码边界记录，回执也已告知模型；这一步不投递、不计动作。
    if (!outcome.ok) return JSON.stringify({ synthesis: "failed" });
    return voiceDelivery(accepted, outcome.voice)(chatAction, pause);
  });

  return production.foreground.then((outcome: VoiceSynthesisResult | null): string => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (outcome !== null && !outcome.ok) return toolError(SEND_VOICE_SYNTHESIS_FAILED_TOOL_ERROR, { retryable: false });
    return acceptanceReceipt(outcome === null);
  });
}

/**
 * 语音执行器：准入在调用时同步完成，通过后开始合成；直接轮在调用内发出，有序并行轮把投递排进
 * 串行链，都最多等一个前台窗口。
 */
export function createSendVoiceExecutor(
  ctx: ReplyToolContext,
  chains: ReplyActionChains
): (argumentsJson: string) => string | Promise<string> {
  let acceptedVoices: number = 0;
  return (argumentsJson: string): string | Promise<string> => {
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
    if (tts === undefined || !claimTtsUsage("ai", ttsQuotaLimit(tts, "ai"))) {
      return toolError(SEND_VOICE_DAILY_LIMIT_TOOL_ERROR, { retryable: false });
    }
    acceptedVoices++;
    const accepted: AcceptedVoice = {
      ctx,
      chains,
      parsed,
      production: startVoiceProduction(ctx, synthesizer.synthesize, parsed),
    };
    return ctx.direct ? deliverVoiceDirectly(accepted) : queueVoiceDelivery(accepted);
  };
}
