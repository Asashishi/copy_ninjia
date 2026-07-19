import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import { sendMessage, banChatMember, banChatSenderChat, isChatMember, deleteMessageAfter } from "../infra/telegram";
import { formatMockerLabel, formatUserLabel } from "../users/userLabel";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { resolveCommandTarget } from "./targetResolution";
import { isBotAdminIn } from "../infra/botAdmin";
import { getAllChatStates } from "../infra/storage/stateStore";

/**
 * 处理 /kick 指令：将目标在所有「机器人是管理员」的群里同时封禁（与入群
 * 验证/反刷群的自动踢出不同——那些踢而不 ban 以防误杀，这里是管理员的手动
 * 判断，直接全网封死）。封禁对还没加入的群同样生效，目标之后也进不去，
 * 但那终究不是「踢」——战报文案按目标此刻是否在场分别措辞（isChatMember）：
 * 真在场的算踢出去，压根没进过的群只算提前拉黑。群清单来自各群
 * ChatState.botIsAdmin（见 infra/botAdmin.ts）。机器人
 * 在发起命令的这个群里不是管理员时，本群自然踢不了，但对其它管理的群的
 * 连坐封禁照常执行，只在回复里说明本群没踢；一个管理的群都没有才整体拒绝。
 * 目标解析和 /copy 一致：回复目标的一条消息优先，也可以用 /kick @username
 * 指定（要求本机器人此前缓存过该用户）。目标若是频道马甲（sender_chat），
 * 则改走 banChatSenderChat 封掉该频道身份的发言权。仅限 PRIVILEGED_USERS_ID
 * 白名单内的用户使用——其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleKickCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!fromUser || !PRIVILEGED_USERS_ID.includes(fromUser.id)) {
    const replyText: string = `就 ${formatMockerLabel(fromUser)} 也想 /kick 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 语义见函数顶部说明（本群非管理员不影响其它群连坐）。
  const isAdminHere: boolean = await isBotAdminIn(chatId);

  // 目标解析同 /copy：回复目标的消息优先于参数里的 @username（没有公开
  // username 或没被缓存过的目标只能靠回复锁定），见 targetResolution.ts。
  const targetUser: CachedUser | undefined = await resolveCommandTarget(ctx, {
    missingTarget: `笨蛋，要么 /kick @username，要么回复 TA 的一条消息再 /kick，本天才可不会读心术♡`,
    invalidUsername: (rawArgument: string) => `笨蛋，${rawArgument} 才不是完整合法的 Telegram 用户名，别拿半截参数糊弄本天才♡`,
    unknownUsername: (rawUsername: string) => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /kick 吧♡`,
    selfTarget: `笨蛋，本天才才不会把自己踢出去呢♡`,
  });
  if (!targetUser) return;

  // 封禁清单：所有已记录「机器人是管理员」的群。本群是管理员时排最前
  // （踢发起群里的目标最紧迫），不是管理员时不进清单——试也没用。共享
  // bot.api 已安装限流与自动重试，但跨群封禁仍保持串行，避免一次命令制造
  // 突发请求，也让成功/失败计数按确定顺序收敛。
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

  // 频道马甲（sender_chat）没有「成员」这个概念，banChatSenderChat 本来就
  // 只是拉黑发言权，不存在「把它踢出去」一说，一律算封禁，不查成员状态。
  let kickedCount: number = 0;
  let preBannedCount: number = 0;
  for (const targetChatId of targetChatIds) {
    if (targetUser.isChannel) {
      if (await banChatSenderChat(targetChatId, targetUser.id)) preBannedCount++;
      continue;
    }
    // 先查目标此刻是否在这个群里，再决定战报里算「踢出去」还是「提前拉黑」——
    // banChatMember 本身对两种情况效果一样（都会加入封禁名单），只是文案不能
    // 把「根本没进过的群」也说成踢出去了。
    const wasMember: boolean = await isChatMember(targetChatId, targetUser.id);
    const banned: boolean = await banChatMember(targetChatId, targetUser.id);
    if (banned) {
      if (wasMember) kickedCount++;
      else preBannedCount++;
    }
    // 个别群失败（比如管理员身份记录已过时、缺封禁权限）不中断其余群：
    // banChatMember/banChatSenderChat 内部已带群号记了日志，够排查。
  }

  const bannedCount: number = kickedCount + preBannedCount;
  if (bannedCount === 0) {
    const replyText: string = `呜……${targetLabel} 居然一个群都踢不动，是本天才没有封禁权限吧？杂鱼管理员快去检查♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 本群不是管理员时明确说清：本群这个人还留着，被拉黑的是其它群。
  const notAdminHereNote: string = isAdminHere ? "" : `本天才在这个群不是管理员、这里踢不动 TA，不过——`;
  const failedCount: number = targetChatIds.length - bannedCount;
  const failedNote: string = failedCount > 0 ? `（还有 ${failedCount} 个群没踢动，杂鱼管理员快去检查权限）` : "";
  // 踢出去/提前拉黑文案区分见函数顶部说明。
  const kickedNote: string = kickedCount > 0 ? `从 ${kickedCount} 个群一脚踢出去还上了黑名单` : "";
  const preBannedNote: string = preBannedCount > 0 ? `在 ${preBannedCount} 个群提前拉黑（根本没让 TA 进去过）` : "";
  const actionNote: string = [kickedNote, preBannedNote].filter(Boolean).join("，");
  const noticeMessageId: number | undefined = await sendMessage(
    chatId,
    `${notAdminHereNote}哼，${targetLabel} 被本天才${actionNote}${failedNote}，杂鱼永远别想回来了♡`,
    messageId
  );
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS);
  }
}
