import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import { sendMessage } from "../infra/telegram";
import { resolveReplyTarget, resolveUsernameTarget } from "../users/senderIdentity";
import { USERNAME_ARG_PATTERN } from "../consts/commands";

/** 目标解析失败时按场景发送的提示文案，由调用方（各命令）定制措辞。 */
export interface CommandTargetMessages {
  /** 既没有回复消息、也没给 @username 参数。 */
  missingTarget: string;
  /** 给了非空参数，但它不是一整个合法的 Telegram @username。 */
  invalidUsername: (rawArgument: string) => string;
  /** 给了 @username，但本天才没缓存过这个人（未曾在群里发言过）。 */
  unknownUsername: (rawUsername: string) => string;
  /** 解析出的目标是机器人自己。 */
  selfTarget: string;
}

/**
 * 解析命令的目标用户/频道：回复目标的消息优先于参数里的 @username——这样
 * 即使对方没有公开 username、或者本天才还没缓存过 TA（比如 privacy mode
 * 没关导致漏听），只要能回复到 TA 发的一条消息就能直接锁定目标。
 * /copy 系与 /kick 共用同一套解析流程，只是失败时的嘲讽文案不同。
 * @returns 解析出的目标；失败时为 undefined（提示已发送，调用方应直接返回）。
 */
export async function resolveCommandTarget(
  ctx: CommandContext<Context>,
  messages: CommandTargetMessages
): Promise<CachedUser | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  let targetUser: CachedUser | undefined = resolveReplyTarget(ctx.msg);
  let rawUsername: string | undefined;

  if (!targetUser) {
    const rawArgument: string = ctx.match.trim();
    if (rawArgument.length === 0) {
      await sendMessage(chatId, messages.missingTarget, messageId);
      return undefined;
    }
    const usernameMatch = USERNAME_ARG_PATTERN.exec(rawArgument);
    if (!usernameMatch) {
      await sendMessage(chatId, messages.invalidUsername(rawArgument), messageId);
      return undefined;
    }
    rawUsername = usernameMatch[1]!;
    targetUser = resolveUsernameTarget(rawUsername);
  }

  if (!targetUser) {
    await sendMessage(chatId, messages.unknownUsername(rawUsername!), messageId);
    return undefined;
  }

  // 不能把本天才自己设成目标：/copy 会自己套自己没完没了，/kick 更是无稽之谈。
  if (targetUser.id === ctx.me.id) {
    await sendMessage(chatId, messages.selfTarget, messageId);
    return undefined;
  }

  return targetUser;
}
