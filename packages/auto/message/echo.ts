import type { Message } from "grammy/types";
import type { CopyMode } from "../../types/chatState";
import { activeCopyTargetIdIn } from "../../infra/storage/stateStore";
import { sendEchoPayload } from "../../copy/echo";
import { applyCopyModeTransform } from "../../copy/copyModes";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import { containsRenderableCommand } from "../../libs/renderableCommand";

/**
 * 将消息复读回所在聊天（`/copy` 系与随机复读）。文字与图注一律按字符串处理：有模式时
 * 变换，没有模式时原样使用，链接、@ 与格式实体都不再单独处理；发送经 copy/echo.ts 的
 * sendEchoPayload（纯文字重新发送，媒体复制并换图注）。发送前核对锁定目标，只允许
 * 当前 copy 会话继续发送。
 */
export interface EchoMessageParams {
  chatId: number;
  message: Message;
  mode: CopyMode | undefined;
  expectedTargetId?: number;
  /**
   * 复读要落进的论坛话题；General、非论坛群为 undefined。
   *
   * 复读**不挂回复**（复读的是原话，不是回原话），所以话题群里缺了它，被复读的
   * 人在自己话题里说话、本天才却在 General 学舌（判定见 libs/forumTopic.ts）。
   */
  messageThreadId?: number;
}

/** @returns 发出去的文字；没发出去或原消息没有文字时为 undefined。 */
export async function echoMessage(params: EchoMessageParams): Promise<string | undefined> {
  const { chatId, message, mode, expectedTargetId, messageThreadId }: EchoMessageParams = params;
  // caption 也要看：一条 caption 写着 `/batch_kick 1d` 的图片被复读出去时，Telegram 会把
  // 机器人自己发出的那句 caption 渲染成可点击的命令链接。判定不用 `startsWith("/")`：
  // bot_command 不只认行首，`喵 /batch_kick 1d` 同样能被点击。
  const source: string | undefined = message.text ?? message.caption;
  if (source !== undefined && containsRenderableCommand(source)) return undefined;

  const text: string | undefined = source === undefined ? undefined : applyCopyModeTransform(source, mode);
  if (text !== undefined) {
    // 上面那道守卫看的是**变换前**的原文，真正发出去的是这一串：`reverse` 能把
    // `d1 kcik_hctab/` 倒成 `/batch_kick 1d`。守卫和被守卫的值必须是同一个字符串，
    // 命中即整条丢弃，不退化成原样复制。
    if (containsRenderableCommand(text)) return undefined;
    // 变换可能撑破上限（nya 的后缀）；超限整条丢弃，不发一个注定被拒的请求。
    const limit: number = typeof message.text === "string" ? TELEGRAM_MESSAGE_MAX_CHARS : TELEGRAM_CAPTION_MAX_CHARS;
    if (text.length > limit) return undefined;
  }

  if (expectedTargetId !== undefined && activeCopyTargetIdIn(chatId) !== expectedTargetId) {
    return undefined;
  }
  return await sendEchoPayload({ chatId, message, text, messageThreadId }) ? text : undefined;
}
