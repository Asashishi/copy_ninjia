/**
 * 「部署配置写坏了就别让这个功能动」的统一拒绝点。
 *
 * 启动预检已拒绝存在但非法的部署输入；本边界读取各功能的 readiness，
 * 对缺省或能力不完整的配置发送拒绝回执并记录诊断，不改变功能状态。
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
