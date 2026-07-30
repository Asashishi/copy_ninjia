import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import { sendMessage, deleteMessageAfter, unbanChatMemberIfBanned, unbanChatSenderChat } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { UNBLOCK_ALL_FLAG } from "../consts/commands";
import { resolveCommandTarget } from "./targetResolution";
import {
  hasCommandPermission,
  resolveCommandActor,
} from "./commandActor";
import { isBotAdminIn } from "../infra/botAdmin";
import {
  confirmBlocklistPersisted,
  forgetUserConfirmedKicked,
  isUserConfiguredBlocked,
  unblockUser,
} from "../infra/blocklist";
import { getAllChatStates } from "../infra/storage/stateStore";

/**
 * 处理 /unblock 指令：把目标从持久化黑名单里移除，与 /block 互为逆操作。
 *
 * 落盘方式和 /block 不一样：黑名单文件是追加型的，删不掉已有条目，所以这里
 * 是「先从主线程内存 Map 删掉这个 id，再把删除之后的整份 Map 投给落盘 Worker
 * 整文件原子重写」（见 infra/blocklist.ts 与 workers/diskIO/blocklistFile.ts）。
 *
 * **默认不解除各群的 Telegram 封禁。** /block 当时在所有管理群调了
 * banChatMember，那是群级封禁，与本机器人的名单是两套东西：移出名单只保证
 * 「以后再进群不会被本天才秒踢」。要连群级封禁一起解，加 `all` 参数
 * （`/unblock @username all`，或回复 TA 的消息后 `/unblock all`）。
 *
 * `all` 需要 isCanUnBlockAll，而普通移出名单需要 isCanUnBlock；超级管理员
 * 保留两项既有权限。跨群解封会在每一个管理群里放开一个此前被判定为需要永久
 * 隔离的人，波及面比「以后不再秒踢」大一档，值得单独收紧一级。
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

  if (!actor || !hasCommandPermission(ctx, "isCanUnBlock", true)) {
    const replyText: string = `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想 /unblock 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  // `all` 是独立的一个词，不可能和目标参数混淆：Telegram 用户名至少
  // TELEGRAM_USERNAME_MIN_LENGTH 个字符，三个字母的 all 永远过不了
  // USERNAME_ARG_PATTERN；它也不是十进制数字，同样过不了 USER_ID_ARG_PATTERN。
  // 摘掉它，剩下的才是目标参数。
  const tokens: string[] = ctx.match.trim().split(/\s+/).filter(Boolean);
  const unbanEverywhere: boolean = tokens.some((token: string): boolean => token.toLowerCase() === UNBLOCK_ALL_FLAG);
  const targetArgument: string = tokens
    .filter((token: string): boolean => token.toLowerCase() !== UNBLOCK_ALL_FLAG)
    .join(" ");

  if (unbanEverywhere && !hasCommandPermission(ctx, "isCanUnBlockAll", true)) {
    await sendMessage({
      chatId,
      text: `笨蛋，${formatUserLabel(actor)} 还没资格让本天才把人从所有群里放出来，要单独授予 isCanUnBlockAll 才行♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    // 同 /block：解除的对象也是一个 id，允许直接给 id。
    acceptUserId: true,
    // 只有这条命令认负数 id，理由见函数顶部说明与 targetResolution.ts。
    acceptChatId: true,
    messages: {
      missingTarget: `笨蛋，要么 /unblock @username 或 /unblock 用户id（频道就给那串负数 id），要么回复 TA 的一条消息再 /unblock，本天才可不会读心术♡（加个 all 才会顺手把各群的封禁也解了）`,
      invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是 id（用户是正整数，频道是那串负数），别拿半截参数糊弄本天才♡`,
      unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /unblock 吧♡`,
      conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想解封谁就只留一个，要么删掉参数、要么别回复♡`,
      selfTarget: `笨蛋，本天才本来就没把自己拉黑呀♡`,
    },
  });
  if (!targetUser) return;

  // 与 /block 同一道闸（见 commands/block.ts 与 docs/04-invariants.md 的
  // 「破坏性的成员操作必须拒绝把当前群 identity 当作用户目标」）：匿名管理员拿
  // 当前群当皮套时，resolveCommandTarget 按设计返回的是这个群自己的 identity。
  // 放它过去的话，unbanChatSenderChat(chatId, chatId) 自解封必然报错、落进
  // failedCount，管理员会收到一条「已在 N 个群解开、还有 1 个群没解开，快去检查
  // 权限」——一份关于「根本没被碰过的人」的假战报，还把运维引向一个其实没坏的群。
  // 只挡当前群自己：在群里发言的关联频道 sender_chat 是另一个 id，照常可解。
  // 开了 acceptChatId 之后这道闸多守一种手滑——把本群的 id 直接粘进参数，
  // 落点与匿名管理员皮套完全相同，文案因此要把两条路都念到。
  if (targetUser.isChannel === true && targetUser.id === chatId) {
    await sendMessage({
      chatId,
      text: `笨蛋，这是本群自己的身份呀——匿名管理员拿它当皮套时，Telegram 也不会告诉本天才皮套底下是谁；本天才没法把整个群当成那个人从小本本上划掉♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const targetLabel: string = formatTargetLabel(targetUser);
  // 静态层只能由部署者改 config/blocklist.json 后重启。允许 /unblock 继续往下
  // 只会制造“内存里划掉了、下一次查询却仍然命中”的假成功；带 all 时更不能
  // 一边保留黑名单、一边把各群 Telegram 封禁解开。
  if (isUserConfiguredBlocked(targetUser.id)) {
    await sendMessage({
      chatId,
      text: `笨蛋，${targetLabel} 是写在 config/blocklist.json 里的固定黑名单，/unblock 可划不掉；先改配置再重启呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }
  // 这份缓存只证明 `/block` 今天曾在某群确证踢出过，并不代表此刻仍被封。
  // 尤其 `all` 会真的跨群解封；先失效，随后同日重新 /block 才会重新查成员并封禁。
  forgetUserConfirmedKicked(targetUser.id);
  // 先删内存 Map、再投递重写——顺序不能反。反过来的话，两步之间到达的入群
  // 更新会查到一个还没解除的名单，那个人白白被秒踢一次。
  const removedFromList: boolean = unblockUser(targetUser.id);
  // 不带 all 时「本来就不在名单里」就没什么可做的；带 all 时照样往下走——
  // 「把人彻底放回来」正是这个参数的全部意义，名单里没有他不代表各群没封他。
  if (!removedFromList && !unbanEverywhere) {
    await sendMessage({
      chatId,
      text: `笨蛋，${targetLabel} 本来就不在本天才的小本本上，有什么好划掉的呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // 重写没落盘就不能说「划掉了」：文件里那条还在，重启后这个人会重新回到
  // 名单上，而管理员以为已经放过 TA 了。没动过名单就不必等这一次回执。
  const persisted: boolean = removedFromList ? await confirmBlocklistPersisted() : true;
  const persistWarning: string = persisted
    ? ""
    : `（不过小本本没能写进硬盘，重启后 TA 还会回到名单上，杂鱼管理员快去查磁盘）`;

  const listNote: string = removedFromList
    ? `本天才勉为其难把 ${targetLabel} 从小本本上划掉啦${persistWarning}`
    : `${targetLabel} 本来就不在小本本上`;

  if (!unbanEverywhere) {
    await replyAndScheduleDelete({
      chatId,
      messageId,
      text: `哼，${listNote}——不过之前在各群挨的封禁本天才可不管，要放 TA 回来还得杂鱼管理员自己去各群解封哦♡`,
    });
    return;
  }

  const { unbannedCount, failedCount }: UnbanOutcome = await unbanEverywhereFor(targetUser, chatId);
  // runner 只按 chat 串行：其它群里的 `/block` 可能在上面逐群 await 解封期间
  // 回填新的“确证踢出”。解封结局在时序上更晚，完成边界必须再失效一次；
  // 否则同日下一次 `/block` 会拿解封前的迟到结果跳过成员查询与重新封禁。
  forgetUserConfirmedKicked(targetUser.id);
  if (unbannedCount === 0 && failedCount === 0) {
    await replyAndScheduleDelete({
      chatId,
      messageId,
      text: `哼，${listNote}——不过本天才一个群的管理员都不是，各群的封禁想解也解不了呀♡`,
    });
    return;
  }
  const failedNote: string = failedCount > 0 ? `（还有 ${failedCount} 个群没解开，杂鱼管理员快去检查权限）` : "";
  await replyAndScheduleDelete({
    chatId,
    messageId,
    text: `哼，${listNote}，还在 ${unbannedCount} 个群把封禁一并解开了${failedNote}——这次真的放 TA 回来了，别再让本天才失望哦♡`,
  });
}

interface UnbanOutcome {
  unbannedCount: number;
  failedCount: number;
}

interface ReplyParams {
  chatId: number;
  messageId: number | undefined;
  text: string;
}

async function replyAndScheduleDelete({ chatId, messageId, text }: ReplyParams): Promise<void> {
  const noticeMessageId: number | undefined = await sendMessage({ chatId, text, replyToMessageId: messageId });
  if (noticeMessageId !== undefined) {
    deleteMessageAfter({ chatId, messageId: noticeMessageId, delayMs: KICK_NOTICE_AUTO_DELETE_MS });
  }
}

/**
 * 在所有「本天才是管理员」的群里解除该目标的封禁。群清单与 /block 的连坐封禁
 * 同源（各群 ChatState.botIsAdmin），本群排最前；串行执行，避免一次命令制造
 * 突发请求，也让计数按确定顺序收敛。
 */
async function unbanEverywhereFor(targetUser: CachedUser, chatId: number): Promise<UnbanOutcome> {
  const isAdminHere: boolean = await isBotAdminIn(chatId);
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getAllChatStates()) {
    if (chatState.botIsAdmin === true && adminChatId !== chatId) targetChatIds.push(adminChatId);
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
