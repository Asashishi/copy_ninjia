import type { Message } from "@grammyjs/types";
import type { CopyMode } from "../../types/chatState";
import { getActiveCopyIn, getChatState } from "../../infra/storage/stateStore";
import { copyMessage, sendMessage } from "../../infra/telegram";
import { applyCopyModeTransform } from "../../copy/copyModes";

/** ja 模式关闭时只取消翻译变换，复读本身仍退化为原样复制。 */
export function resolveEffectiveCopyMode(chatId: number, mode: CopyMode | undefined): CopyMode | undefined {
  if (mode === "ja" && getChatState(chatId).isJATranslationEnabled !== true) return undefined;
  return mode;
}

/**
 * 将消息复读回所在聊天。只有无 entity 的纯文本会执行文本变换，避免变换后
 * entity 偏移量失效；其余消息一律 copyMessage。锁定目标路径会在异步翻译
 * 返回后重新核对目标，防止另一群已经结束全局复读会话后仍迟到补发。
 */
export async function echoMessage(
  chatId: number,
  message: Message,
  mode: CopyMode | undefined,
  expectedTargetId?: number
): Promise<string | undefined> {
  const text: string = message.text || "";
  if (text.startsWith("/")) return undefined;

  const plainText: string | undefined =
    typeof message.text === "string" &&
    (!message.entities || message.entities.length === 0)
      ? message.text
      : undefined;
  const transformed: string | null = plainText !== undefined
    ? await applyCopyModeTransform(plainText, mode)
    : null;

  if (expectedTargetId !== undefined && getActiveCopyIn(chatId)?.copiedUser.id !== expectedTargetId) {
    return undefined;
  }

  if (transformed !== null) {
    const sentMessageId: number | undefined = await sendMessage(chatId, transformed);
    return sentMessageId !== undefined ? transformed : undefined;
  }

  const copiedMessageId: number | undefined = await copyMessage(chatId, chatId, message.message_id);
  return copiedMessageId !== undefined && typeof message.text === "string" ? message.text : undefined;
}
