import type { Message } from "@grammyjs/types";
import type { CopyMode } from "../../types/chatState";
import { isJaTranslationActiveIn } from "../../copy/availability";
import { getActiveCopyIn } from "../../infra/storage/stateStore";
import { copyMessage, sendMessage } from "../../infra/telegram";
import { applyCopyModeTransform } from "../../copy/copyModes";
import { containsRenderableCommand } from "../../libs/renderableCommand";

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
    ? await applyCopyModeTransform(plainText, mode)
    : null;

  if (expectedTargetId !== undefined && getActiveCopyIn(chatId)?.copiedUser.id !== expectedTargetId) {
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
    const sentMessageId: number | undefined = await sendMessage({ chatId, text: transformed });
    return sentMessageId !== undefined ? transformed : undefined;
  }

  const copiedMessageId: number | undefined = await copyMessage(chatId, chatId, message.message_id);
  return copiedMessageId !== undefined && typeof message.text === "string" ? message.text : undefined;
}
