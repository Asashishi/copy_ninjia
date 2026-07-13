import { logger } from "../infra/logger";
import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState } from "../types";
import { sendMessage, copyUserProfilePhoto } from "../infra/telegram";
import { resolveReplyTarget } from "../users/senderIdentity";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import { COPY_COOLDOWN_MS } from "../consts/commands";

/**
 * copy 类命令（/copy 系与 /steal_icon）的公共零件：共享冷却检查、
 * 目标解析（回复消息优先于 @username 参数）、后台偷头像任务。
 */

/**
 * copy 类命令的公共冷却检查。全局共享一份 lastCopyTime 冷却时钟：只要不是
 * 白名单用户触发，任何 copy 类命令（不管是换目标、重复同一个目标，还是回复
 * 消息触发）一律先查时间——冷却没到就发提示拦下。
 * @returns 若仍在冷却中（提示已发送，调用方应直接返回）为 true，否则为 false。
 */
export async function rejectIfOnCopyCooldown(
  state: ChatState,
  fromUser: { id: number } | undefined,
  chatId: number,
  messageId: number | undefined
): Promise<boolean> {
  const isExempted: boolean = !!fromUser && PRIVILEGED_USERS_ID.includes(fromUser.id);
  if (isExempted || !state.lastCopyTime) return false;

  const elapsed: number = Date.now() - state.lastCopyTime;
  if (elapsed >= COPY_COOLDOWN_MS) return false;

  const remainingMs: number = COPY_COOLDOWN_MS - elapsed;
  const remainingMinutes: number = Math.floor(remainingMs / 60000);
  const remainingSeconds: number = Math.ceil((remainingMs % 60000) / 1000);
  const timeStr: string = remainingMinutes > 0
    ? `${remainingMinutes} 分 ${remainingSeconds} 秒`
    : `${remainingSeconds} 秒`;
  await sendMessage(chatId, `急什么呀笨蛋，还要等 ${timeStr} 才能用 copy 类命令哦，乖乖等着吧♡`, messageId);
  return true;
}

/**
 * 解析 copy 类命令的目标用户/频道。回复目标的消息优先于参数里的 @username：
 * 这样即使对方没有公开 username、或者本天才还没缓存过 TA（比如 privacy mode
 * 没关导致漏听），只要能回复到 TA 发的一条消息就能直接锁定目标。解析失败
 * （没给目标、@username 没缓存、目标是机器人自己）时反馈已发送。
 * @param commandName 触发的命令名（如 "/copy"、"/steal_icon"），用于错误提示文案。
 * @returns 解析出的目标；失败时为 undefined（提示已发送，调用方应直接返回）。
 */
export async function resolveCopyCommandTarget(
  ctx: CommandContext<Context>,
  users: Record<string, CachedUser>,
  commandName: string
): Promise<CachedUser | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const replyTarget: CachedUser | undefined = resolveReplyTarget(ctx.msg as any);

  let targetUser: CachedUser | undefined = replyTarget;
  let rawUsername: string | undefined;

  if (!targetUser) {
    const usernameMatch = ctx.match.trim().match(/^@?([a-zA-Z0-9_]+)/);
    if (!usernameMatch) {
      const replyText: string = `笨蛋，要么 ${commandName} @username，要么直接回复 TA 的一条消息再 ${commandName}，本天才总得知道杂鱼是谁吧♡`;
      await sendMessage(chatId, replyText, messageId);
      return undefined;
    }
    rawUsername = usernameMatch[1]!;
    targetUser = users[rawUsername.toLowerCase()];
  }

  if (!targetUser) {
    const replyText: string = `笨蛋，@${rawUsername} 都还没说过话呢，本天才要怎么记住这种杂鱼呀，先让 TA 冒个泡，或者直接回复 TA 的消息来 ${commandName} 呀♡`;
    await sendMessage(chatId, replyText, messageId);
    return undefined;
  }

  // 不能把本天才自己设成目标：复制会自己套自己没完没了，偷自己的头像也没有意义
  if (targetUser.id === ctx.me.id) {
    await sendMessage(chatId, `笨蛋，本天才怎么可能盯上自己呀♡`, messageId);
    return undefined;
  }

  return targetUser;
}

/**
 * 在后台把目标的头像偷来设为机器人自己的头像，完成后按结果发送战报。
 * 不阻塞主消息处理：即使头像抓取失败或耗时很久，也不会卡住调用方的后续
 * 逻辑（比如 /copy 的复读已经生效）。
 * @param successText 头像更换成功时发送的文本。
 * @param failureText 头像更换失败时发送的文本。
 */
export function stealAvatarInBackground(chatId: number, target: CachedUser, successText: string, failureText: string): void {
  void (async (): Promise<void> => {
    const photoUpdated: boolean = await copyUserProfilePhoto(target.id, !!target.isChannel, target.username);
    await sendMessage(chatId, photoUpdated ? successText : failureText);
  })().catch((error: unknown) => {
    logger.error("Error in background avatar steal task:", error);
  });
}
