/**
 * 「部署配置写坏了就别让这个功能动」的统一拒绝点。
 *
 * 这些文件不再在启动时统一预热（理由见 config/readiness.ts）：一份写坏的
 * 贴纸白名单不该让 copy、抽奖、入群验证、黑名单跟着离线。代价是判定要挪到
 * 各功能自己的命令上，而这几条命令对这件事的处理必须完全一致——点名到具体
 * 文件、日志里留下英文诊断、状态一个字都不改。
 */

import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import type { ConfigReadiness } from "../types/config";

export interface RefuseIfConfigBrokenParams {
  /** 本次判定的结论，由各功能自己的 readiness 函数给出。 */
  readiness: ConfigReadiness;
  chatId: number;
  /** 触发这条命令的消息，用于挂回复引用；私聊/频道场景可能没有。 */
  messageId: number | undefined;
  /** 出现在英文错误日志里的功能名，如 `AI chat`。 */
  feature: string;
  /** 拒绝文案；参数是坏掉的那份文件的相对路径，务必原样带进文案。 */
  text: (file: string) => string;
}

/**
 * 配置可用就什么都不做；不可用则记一行诊断、回一条点名文件的拒绝，并告诉
 * 调用方「已经拒了」。
 * @returns true 表示已经拒绝并回复，调用方必须立刻 return、不得改任何状态。
 */
export async function refuseIfConfigBroken({
  readiness,
  chatId,
  messageId,
  feature,
  text,
}: RefuseIfConfigBrokenParams): Promise<boolean> {
  if (readiness.ok) return false;
  logger.error(
    `${feature} is unavailable in chat ${chatId}: ${readiness.failure.file} is unusable — ${readiness.failure.reason}`
  );
  await sendCommandMessage({ chatId, text: text(readiness.failure.file), replyToMessageId: messageId });
  return true;
}
