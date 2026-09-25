/**
 * `/send` 代发会话里的 TTS 请求。
 *
 * 超级管理员在私聊里发一整条代码块（唯一一个覆盖全文的 `pre` 实体），内容按 JSONC
 * （允许注释与尾逗号）解析为 `{ "type": "tts", "tone"?: 语气, "text": 台词 }` 时，机器人
 * 不复制原消息，而是把台词经 AI Worker 的语音合成公共实现（aiChat/voiceSynthesis.ts）
 * 念成语音，以语音气泡发到代发目标群；语气拼在基础朗读风格之后。别的消息——不是整条
 * 代码块、解析不出 JSON、或 `type` 不是 `tts`——照常代发。
 *
 * `type` 为 `tts` 但键或取值不合规时按格式错误拒绝，不代发；`agent.tts` 未配置时直接
 * 报错。合成与发送耗时较长，接纳后交给延迟命令执行器（commands/deferredCommands.ts），
 * 不占住串行的 update runner；执行器满时回「稍后再试」。合成或发送失败只回一句提示，
 * 代发会话保持开启。给超管的提示都经 sendProxyTtsNotice 发到私聊，不挂延迟删除。
 */

import type { Message, MessageEntity } from "grammy/types";
import { synthesizeVoice } from "../../aiChat";
import { submitDeferredCommand } from "../../commands/deferredCommands";
import { agentTtsConfig } from "../../config/agent";
import {
  VOICE_FILE_NAME,
  VOICE_OPERATOR_TEXT_MAX_CHARS,
  VOICE_TONE_MAX_CHARS,
} from "../../consts/aiChat/voiceMessage";
import { PROXY_TTS_REQUEST_KEYS, PROXY_TTS_REQUEST_TYPE } from "../../consts/proxySend";
import { chatAtmosphere } from "../../infra/atmosphere";
import { logger } from "../../infra/logger";
import { sendMessage, sendVoiceWithResult } from "../../infra/telegram";
import { currentUpdateAbortSignal } from "../../infra/updateContext";
import { hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { sanitizeInline } from "../../libs/text";
import type { VoiceSynthesisResult } from "../../types/aiChat/voiceMessage";
import type { ProxyTtsRequest } from "../../types/proxySend";
import type { TelegramSendResult } from "../../types/telegram";

/** 一次已接纳的 TTS 代发。 */
interface ProxyTtsDelivery {
  readonly privateChatId: number;
  readonly targetChatId: number;
  readonly text: string;
  readonly tone: string | undefined;
}

/** 清洗成单行并去掉首尾空白；非空且不超过上限时返回，否则返回 undefined。 */
function boundedLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line: string = sanitizeInline(value).trim();
  return line.length > 0 && line.length <= maxChars ? line : undefined;
}

/** 消息是不是恰好一整条代码块：唯一一个实体是从头覆盖到尾的 `pre`。 */
function isWholeCodeBlock(text: string, entities: readonly MessageEntity[] | undefined): boolean {
  if (entities?.length !== 1) return false;
  const entity: MessageEntity = entities[0]!;
  return entity.type === "pre" && entity.offset === 0 && entity.length === text.length;
}

/**
 * 把一条私聊消息判定为 TTS 请求。`text` 必填、`tone` 可省；两者清洗成单行后必须非空，
 * 台词不超过 VOICE_OPERATOR_TEXT_MAX_CHARS，语气不超过 VOICE_TONE_MAX_CHARS。
 */
export function parseProxyTtsRequest(message: Message): ProxyTtsRequest {
  const content: string | undefined = message.text;
  if (content === undefined || !isWholeCodeBlock(content, message.entities)) return { kind: "none" };
  let value: unknown;
  try {
    value = Bun.JSONC.parse(content);
  } catch {
    return { kind: "none" };
  }
  if (!isPlainRecord(value) || value.type !== PROXY_TTS_REQUEST_TYPE) return { kind: "none" };
  if (!hasOnlyKeys(value, PROXY_TTS_REQUEST_KEYS)) return { kind: "invalid" };
  const text: string | undefined = boundedLine(value.text, VOICE_OPERATOR_TEXT_MAX_CHARS);
  if (text === undefined) return { kind: "invalid" };
  if (value.tone === undefined) return { kind: "tts", text, tone: undefined };
  const tone: string | undefined = boundedLine(value.tone, VOICE_TONE_MAX_CHARS);
  return tone === undefined ? { kind: "invalid" } : { kind: "tts", text, tone };
}

/** 给超管私聊回一句 TTS 代发提示；私聊提示不挂延迟删除。 */
async function sendProxyTtsNotice(privateChatId: number, text: string): Promise<void> {
  await sendMessage({ chatId: privateChatId, text });
}

/** 延迟执行器里的一次合成与发送；取消时静默收尾，其余失败回一句提示。 */
async function deliverProxyTts({ privateChatId, targetChatId, text, tone }: ProxyTtsDelivery): Promise<void> {
  const signal: AbortSignal | undefined = currentUpdateAbortSignal();
  const result: VoiceSynthesisResult = await synthesizeVoice({ text, tone, signal });
  if (!result.ok) {
    if (result.reason === "aborted") return;
    logger.error(`/send TTS for chat ${targetChatId} produced no voice: ${result.reason}.`);
    await sendProxyTtsNotice(
      privateChatId,
      result.reason === "tts unconfigured"
        ? chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyTtsUnconfigured
        : chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyTtsFailed(targetChatId)
    );
    return;
  }
  // 代发的目标是整个群，与 copyMessage 一样不带话题，落在 General。
  const sent: TelegramSendResult | undefined = await sendVoiceWithResult({
    chatId: targetChatId,
    bytes: result.voice.bytes,
    fileName: VOICE_FILE_NAME,
    signal,
    duration: result.voice.durationSeconds,
  });
  if (sent !== undefined || signal?.aborted === true) return;
  await sendProxyTtsNotice(privateChatId, chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyTtsFailed(targetChatId));
}

/**
 * 处理一条已判定为 TTS 的代发消息：格式错误或 `agent.tts` 未配置时回提示，否则交给
 * 延迟执行器；执行器满时回「稍后再试」。
 */
export async function handleProxyTtsRequest(
  message: Message,
  targetChatId: number,
  request: Exclude<ProxyTtsRequest, { readonly kind: "none" }>
): Promise<void> {
  const privateChatId: number = message.chat.id;
  if (request.kind === "invalid") {
    await sendProxyTtsNotice(
      privateChatId,
      chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyTtsUsage(VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS)
    );
    return;
  }
  if (agentTtsConfig() === undefined) {
    await sendProxyTtsNotice(privateChatId, chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyTtsUnconfigured);
    return;
  }
  const delivery: ProxyTtsDelivery = { privateChatId, targetChatId, text: request.text, tone: request.tone };
  const accepted: boolean = submitDeferredCommand(
    "interactive",
    (): Promise<void> => deliverProxyTts(delivery),
    "Unexpected error while processing a /send TTS request:"
  );
  if (!accepted) await sendProxyTtsNotice(privateChatId, chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyTtsBusy);
}
