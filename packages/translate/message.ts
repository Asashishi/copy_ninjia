import { sendEchoPayload } from "../copy/echo";
import type { SendEchoPayloadParams } from "../copy/echo";
import { translateConfigReadiness } from "../config/readiness";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { getChatState } from "../infra/storage/stateStore";
import { containsRenderableCommand } from "../libs/renderableCommand";
import type { TranslateState } from "../types/translate";
import { translateText } from "./client";
import { needsNoTranslation } from "./language";
import { getTranslateState } from "./state";

/** 本群开关和配置前提齐备时返回指定目标的现有会话；无会话时不查询其它状态。 */
export function activeTranslateStateIn(chatId: number, userId: number): TranslateState | undefined {
  const state: TranslateState | undefined = getTranslateState(chatId, userId);
  if (state === undefined || getChatState(chatId).isTranslationEnabled !== true) return undefined;
  return translateConfigReadiness().ok ? state : undefined;
}

/** 翻译发送使用当前会话对象作为取消凭据；不依赖全局 copy 目标。 */
export interface TranslateMessageParams extends Omit<SendEchoPayloadParams, "text"> {
  readonly state: TranslateState;
}

/**
 * 翻译目标的文字与图注：一律按字符串处理，带链接、@ 或格式实体的文字照常翻译。同语种与
 * 中性文字不调用翻译、发送原文；翻译 API 失败同样发送原文。带图片或文件时，文件经
 * copyMessage 原样复制、图注换成译文（copy/echo.ts 的 sendEchoPayload）；没有文字的图片、
 * 文件、贴纸等不发送。异步完成后复核会话，停止或重开后的迟到结果不再发送。
 *
 * 两道可渲染命令闸的结局**不同**，不要按同一条读：
 * - **原文**命中（翻译之前那道闸）：整条不处理，原文也不发。
 * - **译文**命中（翻译成功之后）：**按丢弃处理，不退化为发原文**，也不记日志。
 *   原文此刻已确认不含命令，退回去发原文等于把一条本该被闸住的消息换个形式发出去；
 *   而把 Google 译出来的 `/xxx` 发进群会被 Telegram 当成命令实体渲染。
 *   两种情况都对发送者静默——翻译是旁路增强，不该为它回一条错误提示。
 * 译文超过正文或图注的长度上限时同样丢弃，不发注定被拒的请求。
 */
export async function translateMessage(params: TranslateMessageParams): Promise<void> {
  const { chatId, message, state, messageThreadId }: TranslateMessageParams = params;
  if (activeTranslateStateIn(chatId, state.translatedUser.id) !== state) return;
  const source: string | undefined = message.text ?? message.caption;
  if (source === undefined || containsRenderableCommand(source)) return;

  let text: string = source;
  if (!needsNoTranslation(source, state.language)) {
    const translated: string | null = await translateText(source, state.language);
    if (activeTranslateStateIn(chatId, state.translatedUser.id) !== state) return;
    if (translated !== null) {
      if (containsRenderableCommand(translated)) return;
      text = translated;
    }
  }
  const limit: number = typeof message.text === "string" ? TELEGRAM_MESSAGE_MAX_CHARS : TELEGRAM_CAPTION_MAX_CHARS;
  if (text.length > limit) return;
  await sendEchoPayload({ chatId, message, text, messageThreadId });
}
