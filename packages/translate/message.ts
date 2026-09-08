import { copyEchoMessage } from "../copy/echo";
import type { CopyEchoMessageParams } from "../copy/echo";
import { translateConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
import { containsRenderableCommand } from "../libs/renderableCommand";
import type { TranslateState } from "../types/translate";
import { translateText } from "./client";
import { canCopyWithoutTranslation } from "./language";
import { getTranslateState } from "./state";

/** 本群开关和配置前提齐备时返回指定目标的现有会话；无会话时不查询其它状态。 */
export function activeTranslateStateIn(chatId: number, userId: number): TranslateState | undefined {
  const state: TranslateState | undefined = getTranslateState(chatId, userId);
  if (state === undefined || getChatState(chatId).isTranslationEnabled !== true) return undefined;
  return translateConfigReadiness().ok ? state : undefined;
}

/** 翻译发送使用当前会话对象作为取消凭据；不依赖全局 copy 目标。 */
export interface TranslateMessageParams extends CopyEchoMessageParams {
  readonly state: TranslateState;
}

/**
 * 只处理文字消息，同语种、中性文字和带实体的文字复用普通复制；其余纯文本翻译后发送。
 * 图片、贴纸及其他非文字消息和图注不发送。
 * API 失败原样复制，异步完成后复核会话，停止或重开后的迟到结果不再发送。
 *
 * 两道可渲染命令闸的结局**不同**，不要按同一条读：
 * - **原文**命中（翻译之前那道闸）：整条不处理，普通复制也不做。
 * - **译文**命中（翻译成功之后）：**按丢弃处理，不退化为原文复制**，也不记日志。
 *   原文此刻已确认不含命令，退回去复制等于把一条本该被闸住的消息换个形式发出去；
 *   而把 Google 译出来的 `/xxx` 发进群会被 Telegram 当成命令实体渲染。
 *   两种情况都对发送者静默——翻译是旁路增强，不该为它回一条错误提示。
 */
export async function translateMessage(params: TranslateMessageParams): Promise<void> {
  const { chatId, message, state, messageThreadId }: TranslateMessageParams = params;
  if (activeTranslateStateIn(chatId, state.translatedUser.id) !== state) return;
  if (typeof message.text !== "string") return;
  if (containsRenderableCommand(message.text)) return;
  if (
    (message.entities !== undefined && message.entities.length > 0) ||
    canCopyWithoutTranslation(message.text, state.language)
  ) {
    await copyEchoMessage(params);
    return;
  }

  const translated: string | null = await translateText(message.text, state.language);
  if (activeTranslateStateIn(chatId, state.translatedUser.id) !== state) return;
  if (translated === null) {
    await copyEchoMessage(params);
    return;
  }
  if (containsRenderableCommand(translated)) return;
  await sendMessage({ chatId, text: translated, messageThreadId });
}
