import type { Message } from "@grammyjs/types";
import type { CopyMode } from "../../types/chatState";
import { isJaTranslationActiveIn } from "../../copy/availability";
import { getActiveCopyIn } from "../../infra/storage/stateStore";
import { copyMessage, sendMessage } from "../../infra/telegram";
import { applyCopyModeTransform } from "../../copy/copyModes";

/**
 * ja 模式跑不起来时只取消翻译变换，复读本身仍退化为原样复制。
 *
 * 「跑不起来」含本群没开和进程侧密钥不可用两种（见 copy/availability.ts）：
 * 后者若不在这里挡住，翻译会在底层静默失败并原样发出中文原文——那与
 * 「翻译服务抖了一下」不可区分，而这里退化成普通复制至少行为是确定的。
 */
export function resolveEffectiveCopyMode(chatId: number, mode: CopyMode | undefined): CopyMode | undefined {
  if (mode === "ja" && !isJaTranslationActiveIn(chatId)) return undefined;
  return mode;
}

/**
 * 将消息复读回所在聊天。只有无 entity 的纯文本会执行文本变换，避免变换后
 * entity 偏移量失效；其余消息一律 copyMessage。锁定目标路径会在异步翻译
 * 返回后重新核对目标，防止另一群已经结束全局复读会话后仍迟到补发。
 */
export interface EchoMessageParams {
  chatId: number;
  message: Message;
  mode: CopyMode | undefined;
  expectedTargetId?: number;
}

export async function echoMessage({
  chatId,
  message,
  mode,
  expectedTargetId,
}: EchoMessageParams): Promise<string | undefined> {
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
    const sentMessageId: number | undefined = await sendMessage({ chatId, text: transformed });
    return sentMessageId !== undefined ? transformed : undefined;
  }

  const copiedMessageId: number | undefined = await copyMessage(chatId, chatId, message.message_id);
  return copiedMessageId !== undefined && typeof message.text === "string" ? message.text : undefined;
}
