/**
 * send_voice：把模型写的一句日语台词按可选的本句语气（tone）合成语音，编码成
 * OGG/Opus 后以 Telegram 语音消息发送到当前群。
 *
 * 工具声明逐字恒定，只要 `agent.tts` 配置且实现具备语音合成就挂载；调用与否由
 * 模型按工具说明（SEND_VOICE_TOOL_INSTRUCTION）与回复任务末尾的今日余量行
 * （buildVoiceQuotaLine）判断，执行侧不另设按轮资格。
 *
 * 接纳阶段同步完成资格、单轮限额、模型可见的每日余量与参数校验并预占一个共享动作，
 * 接纳回执带上扣除本次后的余量；独立发送链里经公共实现（aiChat/ai/voiceSynthesis.ts）
 * 按 `ai` 额度口径合成并编码，期间亮「正在录音」状态，发送前切回 idle 并等状态
 * 收敛。落地后按同一消息登记语音自录记号。工具声明、参数口径、单轮限额与挂回复只属于
 * 本工具。
 */

import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { SEND_VOICE_TOOL_INSTRUCTION, voiceQuotaSentence } from "../../../../consts/aiChat/prompts/tools";
import { voiceSentTagTemplate } from "../../../../consts/aiChat/prompts/transcript";
import {
  MAX_VOICES_PER_REPLY,
  VOICE_FILE_NAME,
  VOICE_TEXT_MAX_CHARS,
  VOICE_TONE_MAX_CHARS,
} from "../../../../consts/aiChat/voiceMessage";
import {
  REPLY_INVALIDATED_TOOL_ERROR,
  SEND_VOICE_DAILY_LIMIT_TOOL_ERROR,
  SEND_VOICE_TOOL,
} from "../../../../consts/tools";
import { agentTtsConfig } from "../../../../config/agent";
import { sendVoiceWithResult } from "../../../../infra/telegram";
import { sanitizeInline } from "../../../../libs/text";
import { ttsAiProvider } from "../../../provider";
import { aiTtsRemaining } from "../../ttsUsage";
import { ttsQuotaLimit } from "../../utils/ttsUsageWindow";
import { resolveSpeechSynthesizer, synthesizeVoiceMessage } from "../../voiceSynthesis";
import { parseToolArguments } from "../../utils/toolArgs";
import { toolError } from "../../utils/toolResult";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type { ReplyToolContext, ReplyToolExecution } from "../../../../types/aiChat/replies";
import type { SpeechSynthesizerLookup, VoiceSynthesisResult } from "../../../../types/aiChat/voiceMessage";
import type { TelegramSendResult } from "../../../../types/telegram";
import type { AgentTtsCapabilityConfig } from "../../../../types/config";

/** 本轮是否挂载 send_voice：`agent.tts` 已配置且所选实现具备语音合成。 */
export function isSendVoiceAvailable(): boolean {
  return ttsAiProvider()?.synthesizeSpeech !== undefined;
}

/**
 * 回复任务区块末尾的今日语音余量行（含行首换行），按当前 `agent.tts` 的 `ai` 口径上限
 * 计算；本轮不挂 send_voice 时为空串。回复开始时读取一次，同一回复的工具往返复用。
 */
export function buildVoiceQuotaLine(): string {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  if (tts === undefined || !isSendVoiceAvailable()) return "";
  return "\n" + voiceQuotaSentence(aiTtsRemaining(), ttsQuotaLimit(tts, "ai"));
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

export function createSendVoiceExecutor(
  ctx: ReplyToolContext
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
    const remaining: number = aiTtsRemaining();
    if (remaining <= 0) return toolError(SEND_VOICE_DAILY_LIMIT_TOOL_ERROR, { retryable: false });
    const parsed: ParsedVoiceArguments | null = parseArguments(argumentsJson);
    if (!parsed) {
      return toolError(
        `Invalid voice arguments: text must be a non-empty string of at most ${VOICE_TEXT_MAX_CHARS} characters, ` +
        `tone must be a string of at most ${VOICE_TONE_MAX_CHARS} characters, and reply_to_trigger must be a boolean`
      );
    }
    acceptedVoices++;
    return {
      result: JSON.stringify({ success: true, queued: true, actions_used: 1, voice_remaining_today: remaining - 1 }),
      run: async (chatAction: ChatActionControl): Promise<string> => {
        if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
        chatAction.set("record_voice");
        let encoded: VoiceSynthesisResult;
        try {
          encoded = await synthesizeVoiceMessage(
            synthesizer.synthesize,
            { text: parsed.text, tone: parsed.tone, quota: "ai", signal: ctx.signal },
            `chat ${ctx.chatId}`
          );
        } finally {
          chatAction.set("idle");
          await chatAction.settle();
        }
        if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
        if (!encoded.ok) {
          return encoded.reason === "daily limit reached"
            ? toolError(SEND_VOICE_DAILY_LIMIT_TOOL_ERROR, { retryable: false })
            : toolError("Voice synthesis failed or returned no usable audio", { retryable: false });
        }
        const sent: TelegramSendResult | undefined = await sendVoiceWithResult({
          chatId: ctx.chatId,
          bytes: encoded.voice.bytes,
          fileName: VOICE_FILE_NAME,
          replyToMessageId: parsed.replyToTrigger ? ctx.replyToMessageId : undefined,
          signal: ctx.signal,
          duration: encoded.voice.durationSeconds,
          messageThreadId: ctx.messageThreadId,
        });
        if (sent === undefined) return toolError("Failed to send voice message", { retryable: false });
        ctx.onVoiceSent(voiceSentTagTemplate(parsed.text), sent.messageId, sent.repliedToMessageId);
        return JSON.stringify({ success: true, message_id: sent.messageId, actions_used: 1 });
      },
    };
  };
}
