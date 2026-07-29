import type { Message } from "@grammyjs/types";
import type { CachedUser } from "../types/chatState";
import { sendMessage } from "../infra/telegram";
import { resolveReplyTarget, resolveUsernameTarget } from "../users/senderIdentity";
import { sanitizeInline, truncateInline } from "../libs/text";
import { INVALID_USERNAME_ECHO_MAX_CHARS, USERNAME_ARG_PATTERN } from "../consts/commands";

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
 * resolveCommandTarget 的入参。这里只收命令消息本身与几个标量，不收 grammY 的
 * CommandContext：`/咬` 这类中文动作命令拿不到 bot_command 实体、走的是
 * bot.hears，根本没有 CommandContext 可传（见 commands/cjkAction.ts）。
 */
export interface ResolveCommandTargetParams {
  /** 命令所在会话 id，失败提示发到这里。 */
  chatId: number;
  /** 命令消息本身：既用于解析回复目标，也用于把提示回复到它下面。 */
  message: Message;
  /** 机器人自己的用户 id，用于拒绝把自己当目标。 */
  botUserId: number;
  /** 命令词之后的参数原文，未 trim 也可以。 */
  rawArgument: string;
  /** 解析失败时发送的提示文案。 */
  messages: CommandTargetMessages;
}

/**
 * 只读地看一眼命令目标：回复目标优先，其次查缓存里的 @username。**不发送任何
 * 提示消息**，解析不出来就是 undefined。
 *
 * 用在「这条命令注定要被拒绝、只是想知道目标是谁来挑一句文案」的分支上。那种
 * 地方不能调 resolveCommandTarget：它会为解析失败自己发一条「@x 都还没说过话
 * 呢」然后返回 undefined，用户收到的是一句答非所问的拒绝，真正的原因反而
 * 永远没说出口。
 */
export function peekCommandTarget(message: Message, rawArgument: string): CachedUser | undefined {
  const replyTarget: CachedUser | undefined = resolveReplyTarget(message);
  if (replyTarget) return replyTarget;
  const usernameMatch: RegExpExecArray | null = USERNAME_ARG_PATTERN.exec(rawArgument.trim());
  if (!usernameMatch) return undefined;
  return resolveUsernameTarget(usernameMatch[1]!);
}

/**
 * 解析命令的目标用户/频道：回复目标的消息优先于参数里的 @username——这样
 * 即使对方没有公开 username、或者本天才还没缓存过 TA（比如 privacy mode
 * 没关导致漏听），只要能回复到 TA 发的一条消息就能直接锁定目标。
 * /copy 系、/block 与中文动作命令共用同一套解析流程，只是失败时的嘲讽
 * 文案不同。
 * @returns 解析出的目标；失败时为 undefined（提示已发送，调用方应直接返回）。
 */
export async function resolveCommandTarget({
  chatId,
  message,
  botUserId,
  rawArgument,
  messages,
}: ResolveCommandTargetParams): Promise<CachedUser | undefined> {
  const messageId: number = message.message_id;

  let targetUser: CachedUser | undefined = resolveReplyTarget(message);
  let rawUsername: string | undefined;

  if (!targetUser) {
    const trimmedArgument: string = rawArgument.trim();
    if (trimmedArgument.length === 0) {
      await sendMessage({ chatId, text: messages.missingTarget, replyToMessageId: messageId });
      return undefined;
    }
    const usernameMatch: RegExpExecArray | null = USERNAME_ARG_PATTERN.exec(trimmedArgument);
    if (!usernameMatch) {
      // 回显前压成单行再收进长度上限：参数原文可以长到近 4096 字符，原样插回
      // 提示语就会拼出一条超过 Telegram 单条上限的消息，发不出去，用户只收到
      // 沉默（理由见 consts/commands.ts 的 INVALID_USERNAME_ECHO_MAX_CHARS）。
      // 收在这一层而不是各命令的文案里：四条命令共用同一份 rawArgument。
      const echoed: string = truncateInline(sanitizeInline(trimmedArgument), INVALID_USERNAME_ECHO_MAX_CHARS);
      await sendMessage({ chatId, text: messages.invalidUsername(echoed), replyToMessageId: messageId });
      return undefined;
    }
    rawUsername = usernameMatch[1]!;
    targetUser = resolveUsernameTarget(rawUsername);
  }

  if (!targetUser) {
    await sendMessage({ chatId, text: messages.unknownUsername(rawUsername!), replyToMessageId: messageId });
    return undefined;
  }

  // 不能把本天才自己设成目标：/copy 会自己套自己没完没了，/block 更是无稽之谈。
  if (targetUser.id === botUserId) {
    await sendMessage({ chatId, text: messages.selfTarget, replyToMessageId: messageId });
    return undefined;
  }

  // 不在共享解析层拒绝 targetUser.id === chatId：匿名管理员以当前群为
  // sender_chat 时，/copy 必须保留该身份来复制群头像并复读同一皮套的消息。
  // Telegram 不会提供皮套背后的真实用户；/block 等破坏性命令应在调用处
  // 按自己的语义拒绝，避免误把整个群组身份当作那名管理员。
  return targetUser;
}
