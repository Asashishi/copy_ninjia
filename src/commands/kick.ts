import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types";
import { sendMessage, banChatMember, banChatSenderChat, deleteMessageAfter } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { resolveCommandTarget } from "./targetResolution";

/**
 * 处理 /kick 指令：将目标移出聊天并永久封禁（与入群验证/反刷群的自动踢出
 * 不同——那些踢而不 ban 以防误杀，这里是管理员的手动判断，直接封死）。
 * 目标解析和 /copy 一致：回复目标的一条消息优先，也可以用 /kick @username
 * 指定（要求本机器人此前缓存过该用户）。目标若是频道马甲（sender_chat），
 * 则改走 banChatSenderChat 封掉该频道身份的发言权。仅限 PRIVILEGED_USERS_ID
 * 白名单内的用户使用——其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleKickCommand(ctx: CommandContext<Context>, users: Record<string, CachedUser>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!fromUser || !PRIVILEGED_USERS_ID.includes(fromUser.id)) {
    const mockerLabel: string = fromUser
      ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
      : "哪个杂鱼";
    const replyText: string = `就 ${mockerLabel} 也想 /kick 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 目标解析同 /copy：回复目标的消息优先于参数里的 @username（没有公开
  // username 或没被缓存过的目标只能靠回复锁定），见 targetResolution.ts。
  const targetUser: CachedUser | undefined = await resolveCommandTarget(ctx, users, {
    missingTarget: `笨蛋，要么 /kick @username，要么回复 TA 的一条消息再 /kick，本天才可不会读心术♡`,
    unknownUsername: (rawUsername: string) => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /kick 吧♡`,
    selfTarget: `笨蛋，本天才才不会把自己踢出去呢♡`,
  });
  if (!targetUser) return;

  // 频道马甲（sender_chat）没有可 ban 的用户 id，banChatMember 对它必然报错，
  // 要走 banChatSenderChat 封掉这个频道身份在本群的发言权。
  const banned: boolean = targetUser.isChannel
    ? await banChatSenderChat(chatId, targetUser.id)
    : await banChatMember(chatId, targetUser.id);

  const targetLabel: string = formatUserLabel(targetUser);
  if (!banned) {
    const replyText: string = `呜……${targetLabel} 居然踢不动，是本天才没有封禁权限吧？杂鱼管理员快去检查♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  const noticeMessageId: number | undefined = await sendMessage(chatId, `哼，${targetLabel} 被本天才一脚踢出去还上了黑名单，杂鱼永远别想回来了♡`, messageId);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS);
  }
}
