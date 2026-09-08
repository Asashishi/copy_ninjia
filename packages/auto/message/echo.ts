import type { Message } from "grammy/types";
import type { CopyMode } from "../../types/chatState";
import { activeCopyTargetIdIn } from "../../infra/storage/stateStore";
import { sendMessage } from "../../infra/telegram";
import { copyEchoMessage } from "../../copy/echo";
import { applyCopyModeTransform } from "../../copy/copyModes";
import { containsRenderableCommand } from "../../libs/renderableCommand";

/**
 * 将消息复读回所在聊天。只有无 entity 的纯文本会执行文本变换，避免变换后
 * entity 偏移量失效；其余消息一律走普通复制出口。发送前核对锁定目标，
 * 只允许当前 copy 会话继续发送。
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
   * 两条出口都要带：文本变换走 sendMessage，其余载荷走 copyMessage。
   */
  messageThreadId?: number;
}

export async function echoMessage(params: EchoMessageParams): Promise<string | undefined> {
  const { chatId, message, mode, expectedTargetId, messageThreadId }: EchoMessageParams = params;
  // caption 也要看：只读 message.text 的话，图片/动画/文件消息在这里恒为空串，
  // 一条 caption 写着 `/batch_kick 1d` 的图片会一路走到下面的 copyMessage 被
  // 原样重发，而 Telegram 会把机器人自己发出的那句 caption 渲染成可点击的命令
  // 链接——等于本天才亲手给一条破坏性管理命令造了个一键入口。
  //
  // 判定和下面那道守卫共用 containsRenderableCommand，不再自己写 `startsWith("/")`：
  // 前缀判定只挡得住偏移 0 的命令，`喵 /batch_kick 1d` 这种命令在中段的消息因为
  // 带 bot_command 实体而拿不到 plainText，会直接落到 copyMessage 被原样复读出去——
  // 两条兄弟分支各判各的，等于下面守得再严也能从这里绕过去。
  const commandText: string = message.text ?? message.caption ?? "";
  if (containsRenderableCommand(commandText)) return undefined;

  const plainText: string | undefined =
    typeof message.text === "string" &&
    (!message.entities || message.entities.length === 0)
      ? message.text
      : undefined;
  const transformed: string | null = plainText !== undefined
    ? applyCopyModeTransform(plainText, mode)
    : null;

  if (expectedTargetId !== undefined && activeCopyTargetIdIn(chatId) !== expectedTargetId) {
    return undefined;
  }

  if (transformed !== null) {
    // 上面那道守卫看的是**变换前**的原文，而真正发出去的是这一串：`reverse`
    // 把整句倒过来后，`d1 kcik_hctab/` 会变成 `/batch_kick 1d`——原文不以 `/`
    // 开头，一路放行，最后由本天才亲手发出一条可点击的批量踢人命令。守卫和
    // 被守卫的值必须是同一个字符串，因此这里对最终文本再判一次。
    // 命中即整条丢弃，不退化成 copyMessage：那是把用户原文重发一遍，虽然安全
    // 但复读的内容与本次抽到的模式对不上，不如什么都不说。
    if (containsRenderableCommand(transformed)) return undefined;
    const sentMessageId: number | undefined = await sendMessage({
      chatId,
      text: transformed,
      messageThreadId,
    });
    return sentMessageId !== undefined ? transformed : undefined;
  }

  return copyEchoMessage(params);
}
