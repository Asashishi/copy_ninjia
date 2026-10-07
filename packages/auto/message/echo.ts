import type { Message } from "grammy/types";
import type { CopyMode } from "../../types/chatState";
import { activeCopyTargetIdIn } from "../../infra/storage/stateStore";
import { sendEchoPayload } from "../../copy/echo";
import { applyCopyModeTransform } from "../../copy/copyModes";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import { containsRenderableCommand } from "../../libs/renderableCommand";

/** echoMessage 的入参。 */
export interface EchoMessageParams {
  chatId: number;
  message: Message;
  mode: CopyMode | undefined;
  expectedTargetId?: number;
  /**
   * 复读要落进的论坛话题；General、非论坛群为 undefined。
   *
   * 复读不挂回复，话题由本参数确定（判定见 libs/forumTopic.ts）。
   */
  messageThreadId?: number;
}

/**
 * 将消息复读回所在聊天（`/copy` 系与随机复读）。文字与图注一律按字符串处理：有模式时
 * 变换，没有模式时原样使用，链接、@ 与格式实体不单独处理；发送经 copy/echo.ts 的
 * sendEchoPayload（纯文字重新发送，媒体复制并换图注）。发送前核对锁定目标，只允许
 * 当前 copy 会话继续发送。
 */
export async function echoMessage(params: EchoMessageParams): Promise<void> {
  const { chatId, message, mode, expectedTargetId, messageThreadId }: EchoMessageParams = params;
  // caption 也检查：被复读出去的 caption 含 `/batch_kick 1d` 时 Telegram 会渲染成
  // 可点击的命令链接。判定不用 `startsWith("/")`，bot_command 不只认行首
  // （`喵 /batch_kick 1d`）。
  const source: string | undefined = message.text ?? message.caption;
  if (source !== undefined && containsRenderableCommand(source)) return;

  const text: string | undefined = source === undefined ? undefined : applyCopyModeTransform(source, mode);
  if (text !== undefined) {
    // 上面那道守卫判定变换前的原文，这一道判定实际发出去的串（`reverse` 能把
    // `d1 kcik_hctab/` 倒成 `/batch_kick 1d`）；命中即整条丢弃，不退化成原样复制。
    if (containsRenderableCommand(text)) return;
    // 变换可能撑破上限（nya 的后缀），超限整条丢弃。
    const limit: number = typeof message.text === "string" ? TELEGRAM_MESSAGE_MAX_CHARS : TELEGRAM_CAPTION_MAX_CHARS;
    if (text.length > limit) return;
  }

  if (expectedTargetId !== undefined && activeCopyTargetIdIn(chatId) !== expectedTargetId) {
    return;
  }
  await sendEchoPayload({ chatId, message, text, messageThreadId });
}
