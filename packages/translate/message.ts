import type { Message } from "grammy/types";
import { translateConfigReadiness } from "../config/readiness";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { getChatState } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
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

/** translateMessage 的入参；当前会话对象同时是取消凭据，不依赖全局 copy 目标。 */
export interface TranslateMessageParams {
  readonly chatId: number;
  /** 翻译目标发出的原消息；只读取正文或图注，以及正文消息的链接预览设置。 */
  readonly message: Message;
  readonly state: TranslateState;
  /** 论坛话题；翻译不挂回复，必须显式带上。 */
  readonly messageThreadId?: number;
}

/**
 * 翻译目标的文字与图注：一律按字符串处理，带链接、@ 或格式实体的文字照常翻译。只发送译文：
 * 按纯文字 sendMessage 发出（不带实体、不设 parse_mode，正文消息的 link_preview_options
 * 原样沿用），不发送原文，也不复制图片、文件等媒体——带图注的媒体只发图注译文。以下情况
 * 整条不发送：
 * - 既无正文也无图注（贴纸、不带图注的图片与文件等）；
 * - 同语种或中性文字（needsNoTranslation 命中，不调用翻译）；
 * - 翻译 API 失败，或译文与原文逐字相同；
 * - 原文或译文含可渲染命令：把 Google 译出来的 `/xxx` 发进群会被 Telegram 当成命令实体渲染；
 * - 译文超过正文长度上限，不发注定被拒的请求。
 * 以上都对发送者静默——翻译是旁路增强，不回错误提示；只有 API 异常由 client.ts 记错误日志。
 * 异步完成后复核会话，停止或重开后的迟到结果不再发送。
 */
export async function translateMessage(params: TranslateMessageParams): Promise<void> {
  const { chatId, message, state, messageThreadId }: TranslateMessageParams = params;
  if (activeTranslateStateIn(chatId, state.translatedUser.id) !== state) return;
  const source: string | undefined = message.text ?? message.caption;
  if (source === undefined || containsRenderableCommand(source) || needsNoTranslation(source, state.language)) return;

  const translated: string | null = await translateText(source, state.language);
  if (activeTranslateStateIn(chatId, state.translatedUser.id) !== state) return;
  if (translated === null || translated === source || translated.length > TELEGRAM_MESSAGE_MAX_CHARS) return;
  if (containsRenderableCommand(translated)) return;
  await sendMessage({ chatId, text: translated, messageThreadId, linkPreviewOptions: message.link_preview_options });
}
