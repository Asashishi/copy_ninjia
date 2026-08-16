import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import { UNBLOCK_TARGET_TEXTS } from "../consts/commands";
import { sendCommandMessage, unbanChatMemberIfBanned, unbanChatSenderChat } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { resolveCommandTarget } from "./targetResolution";
import {
  hasCommandPermission,
  resolveCommandActor,
} from "./commandActor";
import { resolveBotAdminStatus } from "../infra/botAdmin";
import {
  confirmBlocklistPersisted,
  unblockUser,
} from "../infra/blocklist/membership";
import { getChatStateCache } from "../infra/storage/stateStore";
import { runBlocklistIdentityMutation } from "../infra/identityPolicy/coordination";

interface UnblockExecutionOutcome extends UnbanOutcome {
  removedFromList: boolean;
  persisted: boolean;
}

/** 同一身份较早的自动封禁结算后，再以本命令的较晚结果覆盖名单与群级封禁。 */
async function executeUnblock(targetUser: CachedUser, originChatId: number): Promise<UnblockExecutionOutcome> {
  // 先发布 LRU 负结论、再投递 tombstone——顺序不能反。反过来的话，两步之间到达的入群
  // 更新会查到一个还没解除的名单，那个人白白被秒踢一次。
  const removedFromList: boolean = unblockUser(targetUser.id);
  // 名单里没有目标不代表各群没有封禁；默认完整解封仍要继续逐群执行。
  const persisted: boolean = removedFromList ? await confirmBlocklistPersisted() : true;
  const { unbannedCount, failedCount }: UnbanOutcome = await unbanEverywhereFor(targetUser, originChatId);
  return { removedFromList, persisted, unbannedCount, failedCount };
}

/**
 * 处理 /unblock 指令：把目标从持久化黑名单里移除，与 /block 互为逆操作。
 *
 * 删除与新增走同一 revision/ACK 协议：先把主线程 LRU 发布为负结论，再向
 * DiskIO Worker 投递 SQLite tombstone；事务 ACK 前由主线程保留并可重放。
 *
 * 命令默认完整解除：先把目标移出黑名单并确认事务落盘，再在所有已知管理群
 * 解除 Telegram 群级封禁。整条操作只认 isCanUnBlock；不再接受 `all` 参数，避免
 * 「名单已移除、群级封禁仍保留」这档容易误解的半完成状态。
 *
 * 目标解析比 /block 多一档：回复目标的一条消息优先，也可以用 /unblock @username、
 * /unblock <用户 id> 或 /unblock <频道的负数 id>。id 不必在缓存里见过——解除
 * 拉黑处置的同样是一个 id，缓存只用来给回执配个人类可读的标签。
 *
 * 负数 id 只有这条命令认，`/block` 仍然拒绝：频道马甲的 id 本来就会进名单
 * （`/block` 回复一条频道消息、广告检测命中 sender_chat），可要把它划掉，此前
 * 只有回复消息与 `@username` 两条路——前者在广告检测删掉原消息后就没了，后者
 * 要求频道有公开 username 且没被挤出缓存，两条都断掉的频道会永远留在名单上。
 * 反方向不开是因为代价不对等：`/block` 粘错一个会话 id 就是封掉整个会话身份且
 * 不可逆，而这里指错至多是一次空解封。
 */
export async function handleUnblockCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);

  if (!actor || !hasCommandPermission(ctx, "isCanUnBlock")) {
    const replyText: string = `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想 /unblock 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  const targetArgument: string = ctx.match.trim();

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    // 同 /block：解除的对象也是一个 id，允许直接给 id。
    acceptUserId: true,
    // 只有这条命令认负数 id，理由见函数顶部说明与 targetResolution.ts。
    acceptChatId: true,
    messages: UNBLOCK_TARGET_TEXTS,
  });
  if (!targetUser) return;

  // 与 /block 同一道闸（见 commands/block.ts 与 docs/cn/04-invariants.md 的
  // 「破坏性的成员操作必须拒绝把当前群 identity 当作用户目标」）：匿名管理员拿
  // 当前群当皮套时，resolveCommandTarget 按设计返回的是这个群自己的 identity。
  // 放它过去的话，unbanChatSenderChat(chatId, chatId) 自解封必然报错、落进
  // failedCount，管理员会收到一条「已在 N 个群解开、还有 1 个群没解开，快去检查
  // 权限」——一份关于「根本没被碰过的人」的假战报，还把运维引向一个其实没坏的群。
  // 只挡当前群自己：在群里发言的关联频道 sender_chat 是另一个 id，照常可解。
  // 开了 acceptChatId 之后这道闸多守一种手滑——把本群的 id 直接粘进参数，
  // 落点与匿名管理员皮套完全相同，文案因此要把两条路都念到。
  if (targetUser.isChannel === true && targetUser.id === chatId) {
    await sendCommandMessage({
      chatId,
      text: `笨蛋，这是本群自己的身份呀——匿名管理员拿它当皮套时，Telegram 也不会告诉本天才皮套底下是谁；本天才没法把整个群当成那个人从小本本上划掉♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const targetLabel: string = formatTargetLabel(targetUser);
  const {
    removedFromList,
    persisted,
    unbannedCount,
    failedCount,
  }: UnblockExecutionOutcome = await runBlocklistIdentityMutation(
    targetUser.id,
    (): Promise<UnblockExecutionOutcome> => executeUnblock(targetUser, chatId)
  );
  // tombstone 没落盘就不能说「划掉了」：数据库里那条还在，重启后这个人会重新回到
  // 名单上，而管理员以为已经放过 TA 了。没动过名单就不必等这一次回执。
  const persistWarning: string = persisted
    ? ""
    : `（不过小本本没能写进硬盘，重启后 TA 还会回到名单上，杂鱼管理员快去查磁盘）`;

  const listNote: string = removedFromList
    ? `本天才勉为其难把 ${targetLabel} 从小本本上划掉啦${persistWarning}`
    : `${targetLabel} 本来就不在小本本上`;

  if (unbannedCount === 0 && failedCount === 0) {
    await sendCommandMessage({
      chatId,
      replyToMessageId: messageId,
      text: `哼，${listNote}——不过本天才一个群的管理员都不是，各群的封禁想解也解不了呀♡`,
    });
    return;
  }
  const failedNote: string = failedCount > 0 ? `（还有 ${failedCount} 个群没解开，杂鱼管理员快去检查权限）` : "";
  await sendCommandMessage({
    chatId,
    replyToMessageId: messageId,
    text: `哼，${listNote}，还在 ${unbannedCount} 个群把封禁一并解开了${failedNote}——这次真的放 TA 回来了，别再让本天才失望哦♡`,
  });
}

interface UnbanOutcome {
  unbannedCount: number;
  failedCount: number;
}

/**
 * 在所有「本天才是管理员」的群里解除该目标的封禁。群清单与 /block 的连坐封禁
 * 同源（各群 ChatState.botPermissions.isAdministrator），本群排最前；串行执行，避免一次命令制造
 * 突发请求，也让计数按确定顺序收敛。
 */
async function unbanEverywhereFor(targetUser: CachedUser, chatId: number): Promise<UnbanOutcome> {
  const isAdminHere: boolean = await resolveBotAdminStatus(chatId);
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getChatStateCache()) {
    if (chatState.botPermissions?.isAdministrator === true && adminChatId !== chatId) {
      targetChatIds.push(adminChatId);
    }
  }

  let unbannedCount: number = 0;
  let failedCount: number = 0;
  for (const targetChatId of targetChatIds) {
    // 频道马甲走 unbanChatSenderChat；真实用户必须走带 only_if_banned 的那个
    // helper，否则「当前就在群里」的人会被 unbanChatMember 直接踢出去
    // （见 infra/telegram/actions.ts 的 kickChatMember 与 unbanChatMemberIfBanned）。
    const lifted: boolean = targetUser.isChannel === true
      ? await unbanChatSenderChat(targetChatId, targetUser.id)
      : await unbanChatMemberIfBanned(targetChatId, targetUser.id);
    if (lifted) unbannedCount++;
    else failedCount++;
  }
  return { unbannedCount, failedCount };
}
