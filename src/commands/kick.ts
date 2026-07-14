import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types";
import { sendMessage, banChatMember, banChatSenderChat, deleteMessageAfter } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { resolveCommandTarget } from "./targetResolution";
import { isBotAdminIn } from "../infra/botAdmin";
import { getAllChatStates } from "../infra/storage";

/**
 * 处理 /kick 指令：将目标在所有「机器人是管理员」的群里同时踢出并永久封禁
 * （与入群验证/反刷群的自动踢出不同——那些踢而不 ban 以防误杀，这里是管理
 * 员的手动判断，直接全网封死；封禁对还没加入的群同样生效，目标之后也进不
 * 去）。群清单来自各群 ChatState.botIsAdmin（见 infra/botAdmin.ts）。机器人
 * 在发起命令的这个群里不是管理员时，本群自然踢不了，但对其它管理的群的
 * 连坐封禁照常执行，只在回复里说明本群没踢；一个管理的群都没有才整体拒绝。
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

  // 本群的管理员身份只决定封禁清单里有没有本群、以及回复里要不要说明
  // 「本群踢不动」——不再一票否决：其它管理的群照样连坐封禁。
  const isAdminHere: boolean = await isBotAdminIn(chatId);

  // 目标解析同 /copy：回复目标的消息优先于参数里的 @username（没有公开
  // username 或没被缓存过的目标只能靠回复锁定），见 targetResolution.ts。
  const targetUser: CachedUser | undefined = await resolveCommandTarget(ctx, users, {
    missingTarget: `笨蛋，要么 /kick @username，要么回复 TA 的一条消息再 /kick，本天才可不会读心术♡`,
    unknownUsername: (rawUsername: string) => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /kick 吧♡`,
    selfTarget: `笨蛋，本天才才不会把自己踢出去呢♡`,
  });
  if (!targetUser) return;

  // 封禁清单：所有已记录「机器人是管理员」的群。本群是管理员时排最前
  // （踢发起群里的目标最紧迫），不是管理员时不进清单——试也没用。逐群
  // 顺序执行——bot.api 没有限流器，一把撒出去容易撞 Telegram 的全局限速，
  // 这个量级串行足够快。
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getAllChatStates()) {
    if (chatState.botIsAdmin === true && adminChatId !== chatId) {
      targetChatIds.push(adminChatId);
    }
  }

  const targetLabel: string = formatUserLabel(targetUser);
  if (targetChatIds.length === 0) {
    await sendMessage(chatId, `笨蛋，本天才连一个群的管理员都不是，${targetLabel} 想踢也踢不动啦，先给本天才上个管理再说♡`, messageId);
    return;
  }

  let bannedCount: number = 0;
  for (const targetChatId of targetChatIds) {
    // 频道马甲（sender_chat）没有可 ban 的用户 id，banChatMember 对它必然
    // 报错，要走 banChatSenderChat 封掉这个频道身份的发言权。
    const banned: boolean = targetUser.isChannel
      ? await banChatSenderChat(targetChatId, targetUser.id)
      : await banChatMember(targetChatId, targetUser.id);
    if (banned) bannedCount++;
    // 个别群失败（比如管理员身份记录已过时、缺封禁权限）不中断其余群：
    // banChatMember/banChatSenderChat 内部已带群号记了日志，够排查。
  }

  if (bannedCount === 0) {
    const replyText: string = `呜……${targetLabel} 居然一个群都踢不动，是本天才没有封禁权限吧？杂鱼管理员快去检查♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 本群不是管理员时明确说清：本群这个人还留着，被拉黑的是其它群。
  const notAdminHereNote: string = isAdminHere ? "" : `本天才在这个群不是管理员、这里踢不动 TA，不过——`;
  const failedCount: number = targetChatIds.length - bannedCount;
  const failedNote: string = failedCount > 0 ? `（还有 ${failedCount} 个群没踢动，杂鱼管理员快去检查权限）` : "";
  const noticeMessageId: number | undefined = await sendMessage(
    chatId,
    `${notAdminHereNote}哼，${targetLabel} 被本天才从 ${bannedCount} 个群一脚踢出去还上了黑名单${failedNote}，杂鱼永远别想回来了♡`,
    messageId
  );
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS);
  }
}
