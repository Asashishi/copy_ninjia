import type { CommandContext, Context } from "grammy";
import type { Message } from "@grammyjs/types";
import type { CachedUser } from "../types/chatState";
import type { DeleteMessageOutcome } from "../infra/telegram";
import {
  sendCommandMessage,
  banChatMember,
  banChatSenderChat,
  isChatMember,
  deleteMessageWithOutcome,
} from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../infra/config";
import { isWhitelisted } from "../config/whitelist";
import { resolveCommandTarget } from "./targetResolution";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import {
  botCanDeleteMessagesIn,
  ensureBotChatPermissions,
  resolveBotAdminStatus,
} from "../infra/botAdmin";
import { logger } from "../infra/logger";
import { runProtectedIdentityMutation } from "../infra/identityPolicy";
import {
  blockUser,
  confirmBlocklistPersisted,
  ensureBlocklistEntryQueued,
  recordUserConfirmedKickedInChat,
  wasUserConfirmedKickedInChat,
} from "../infra/blocklist/membership";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { getAllChatStates } from "../infra/storage/stateStore";

type SenderChatReplyCleanupOutcome =
  | "notApplicable"
  | "deleted"
  | "forbidden"
  | "failed";

interface CleanupSenderChatReplyParams {
  chatId: number;
  commandMessage: Message;
  targetUser: CachedUser;
  isAdminHere: boolean;
}

interface BlockAdmission {
  readonly protected: boolean;
  readonly newlyBlocked: boolean;
}

/** 手动回复频道消息执行 /block 时，独立结算这条已知消息的删除。 */
async function cleanupSenderChatReply({
  chatId,
  commandMessage,
  targetUser,
  isAdminHere,
}: CleanupSenderChatReplyParams): Promise<SenderChatReplyCleanupOutcome> {
  const targetMessageId: number | undefined =
    commandMessage.reply_to_message?.message_id;
  if (
    targetUser.isChannel !== true ||
    targetMessageId === undefined ||
    !isAdminHere
  ) {
    return "notApplicable";
  }

  ensureBotChatPermissions(chatId);
  if (botCanDeleteMessagesIn(chatId) === false) {
    logger.error(
      `Blocked sender chat reply ${targetMessageId} in chat ${chatId} could not be deleted: ` +
      "the bot is known to lack can_delete_messages."
    );
    return "forbidden";
  }

  const outcome: DeleteMessageOutcome = await deleteMessageWithOutcome(
    chatId,
    targetMessageId
  );
  if (outcome === "deleted" || outcome === "gone") return "deleted";
  return outcome;
}

function senderChatCleanupNote(
  outcome: SenderChatReplyCleanupOutcome
): string {
  switch (outcome) {
    case "deleted":
      return "；回复的那条频道消息也被本天才顺手清掉啦，想留垃圾也没门呀";
    case "forbidden":
      return "；可回复的那条频道消息没清掉——杂鱼管理员是不是又忘了给本天才删消息权限呀";
    case "failed":
      return "；可回复的那条频道消息暂时没清掉，杂鱼管理员自己去日志里找原因吧";
    case "notApplicable":
      return "";
  }
}

/**
 * 处理 /block 指令：把目标写进持久化黑名单，并在所有「机器人是管理员」的群里
 * 同时封禁（与入群验证/反刷群的自动踢出不同——那些踢而不 ban 以防误杀，这里
 * 是管理员的手动判断，直接全网封死）。封禁对还没加入的群同样生效，目标之后
 * 也进不去，但那终究不是「踢」——战报文案按目标此刻是否在场分别措辞
 * （isChatMember）：真在场的算踢出去，压根没进过的群只算提前拉黑。群清单来自
 * 各群 ChatState.botIsAdmin（见 infra/botAdmin.ts）。机器人在发起命令的这个群
 * 里不是管理员时，本群自然踢不了，但对其它管理的群的连坐封禁照常执行，只在
 * 回复里说明本群没踢；一个管理的群都没有才整体拒绝。
 *
 * 黑名单先于封禁写入，且即使一个群都没封成也照样保留：这两件事解决的不是
 * 同一个问题——封禁只覆盖此刻已知且有管理权的群，黑名单覆盖的是「以后」，
 * 包括机器人当时还没进、或还不是管理员的群。之后这个 id 出现在任何监听群的
 * 入群更新里都会被秒踢（见 antiRaid/blocklistGuard.ts），名单本身落盘在
 * memory/blocklist/blocklist.json（见 infra/blocklist/）。
 *
 * 目标有三种指定方式：回复目标的一条消息（优先）、`/block @username`（要求本
 * 机器人此前缓存过该用户）、`/block <用户 id>`。**id 那条最可靠**：用户名可以被
 * 释放后由别人重新注册，而 id 不会改指另一个人；这条命令又是不可逆的，因此
 * 拿不准用户名新鲜度时应当用 id 或回复消息。id 只认正整数——群/频道的负数 id
 * 会让处置改去封整个会话身份，那是另一回事。目标若是频道马甲（sender_chat），
 * 则改走 banChatSenderChat 封掉该频道身份的发言权。仅限白名单中
 * isCanBlock=true 的用户或频道身份使用。
 */
export async function handleBlockCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);

  if (!actor || !hasCommandPermission(ctx, "isCanBlock", false)) {
    const replyText: string = `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想 /block 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  // 语义见函数顶部说明（本群非管理员不影响其它群连坐）。
  const isAdminHere: boolean = await resolveBotAdminStatus(chatId);

  // 目标解析同 /copy：回复目标的消息优先于参数里的 @username（没有公开
  // username 或没被缓存过的目标只能靠回复锁定），见 targetResolution.ts。
  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: ctx.match,
    // 处置的对象本来就是一个 id，用 id 指定比 @username 更准（用户名会被释放
    // 后重新注册，而这条命令不可逆），见 targetResolution.ts 的 acceptUserId。
    acceptUserId: true,
    messages: {
      missingTarget: `笨蛋，要么 /block @username 或 /block 用户id，要么回复 TA 的一条消息再 /block，本天才可不会读心术♡`,
      invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数，群和频道那种负数 id 不算），别拿半截参数糊弄本天才♡`,
      unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /block 吧♡`,
      conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；封人这事本天才可不猜——想封谁就只留一个，要么删掉参数、要么别回复♡`,
      selfTarget: `笨蛋，本天才才不会把自己拉黑呢♡`,
    },
  });
  if (!targetUser) return;

  // 匿名管理员以当前群组身份发言时，Telegram 只提供 sender_chat=当前群，
  // 不会暴露皮套背后的真实用户。该身份在 /copy 中必须保留用于头像和复读；
  // 但 /block 若继续执行，只会尝试封禁整个群组身份，不能踢出那名管理员。
  if (targetUser.isChannel === true && targetUser.id === chatId) {
    await sendCommandMessage({
      chatId,
      text: `匿名管理员拿这个群当皮套时，Telegram 不会告诉本天才皮套底下是谁；本天才不能把整个群当成那个人踢掉呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // 自己人不可拉黑。虽然 /unblock 已经提供了撤销路径，这道闸仍然保留：拉黑
  // 会连带在所有管理群 banChatMember；虽然 /unblock 会默认跨群解除，误操作到
  // 修复之间自己人仍会被逐群踢出。回错一条消息、或用了过期的
  // @username 别名，就能把超级管理员或白名单成员踢出并封禁在所有监听群里，
  // 事后要一个群一个群手动解封——值得在入口就挡住。
  const admission: BlockAdmission = await runProtectedIdentityMutation(
    (): BlockAdmission => {
      if (targetUser.id === SUPER_ADMIN_USER_ID || isWhitelisted(targetUser.id)) {
        return { protected: true, newlyBlocked: false };
      }
      return { protected: false, newlyBlocked: blockUser(targetUser.id) };
    }
  );
  if (admission.protected) {
    await sendCommandMessage({
      chatId,
      text: `笨蛋，${formatTargetLabel(targetUser)} 可是自己人，本天才才不会把自己人写进小本本♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // 黑名单先写、且与封禁结果无关：封禁只能覆盖此刻已知且有管理权的群，名单
  // 覆盖的是以后——包括机器人当时还没进的群。先写内存 Map 再落盘，见
  // infra/blocklist/；重复 /block 同一个人时返回 false，不再重复落盘。
  const newlyBlocked: boolean = admission.newlyBlocked;
  // 只有真的新增了记录才值得等这一次落盘回执：没落盘就不能把「永久」说出口。
  // 重复 /block 时也要等：这个 id 若是本进程新增、上一次落盘又失败了，管理员
  // 修好磁盘再跑一次正是最自然的重试动作，不能因为「Map 里已经有了」就静默
  // 跳过——那会连着两次都告诉他成功了，而文件里根本没有这条记录。
  const requeued: boolean = newlyBlocked ? false : ensureBlocklistEntryQueued(targetUser.id);
  const persisted: boolean = newlyBlocked || requeued ? await confirmBlocklistPersisted() : true;

  // 封禁清单：所有已记录「机器人是管理员」的群。本群是管理员时排最前
  // （踢发起群里的目标最紧迫），不是管理员时不进清单——试也没用。
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getAllChatStates()) {
    if (chatState.botIsAdmin === true && adminChatId !== chatId) {
      targetChatIds.push(adminChatId);
    }
  }

  const targetLabel: string = formatTargetLabel(targetUser);
  // 落盘失败必须说破：那条记录只活在本进程内存里，重启就没了，而管理员默认
  // 理解的是「永久」。
  const persistWarning: string = persisted ? "" : `（不过小本本没能写进硬盘，重启就忘了，杂鱼管理员快去查磁盘）`;
  // 一个管理的群都没有时也已经记进黑名单了：现在踢不动，不代表以后进群时
  // 也放过 TA。文案要说清这一点，否则管理员会以为这条命令完全没生效。
  if (targetChatIds.length === 0) {
    await sendCommandMessage({
      chatId,
      text: `笨蛋，本天才连一个群的管理员都不是，${targetLabel} 现在踢也踢不动，不过已经记进小本本了${persistWarning}——再进本天才盯着的任何群就秒踢♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // 频道马甲（sender_chat）没有「成员」这个概念，banChatSenderChat 本来就
  // 只是拉黑发言权，不存在「把它踢出去」一说，一律算封禁，不查成员状态。
  let kickedCount: number = 0;
  let preBannedCount: number = 0;
  // 封禁失败的群要重新欠一次补扫：这个群若早就扫过，sweptAt 那道闩锁会让它
  // 永不重扫，而入群秒踢只对之后的入群更新生效——被拉黑的人就这么在那个群里
  // 待到进程结束（见 infra/blocklist/ 的 requestBlocklistResweep）。
  const resweepChatIds: number[] = [];
  // 各群之间并发：群内那两步是真实依赖（先查在不在，再封），群与群之间不是，
  // 而它们共用同一条装了 throttler 的 bot.api 队列，实际速率仍由它管。逐群串行
  // 的话 40 个群就是 80 次串行往返、约 16 秒里 update 中间件一直不返回，ack 边界
  // 被推后，停机时更容易把 runner drain 拖超时。
  // 个别群失败（管理员身份记录过时、缺封禁权限）不中断其余群：被调函数内部已
  // 带群号记了日志，够排查。
  const perChatOutcomesPromise: Promise<("kicked" | "preBanned" | "failed")[]> = Promise.all(
    targetChatIds.map(async (targetChatId: number): Promise<"kicked" | "preBanned" | "failed"> => {
      if (targetUser.isChannel) {
        return await banChatSenderChat(targetChatId, targetUser.id) ? "preBanned" : "failed";
      }
      // 只复用“今天在这个群查到确实在场、并且 ban 成功”的命令侧结局。
      // 权威名单与 durable outbox 都不能代替它：前者只说明该不该封，后者还
      // 可能在重试/重踢；拿它们跳过 API 会把尚未落定的成员静默留在群里。
      if (wasUserConfirmedKickedInChat(targetChatId, targetUser.id)) return "kicked";
      // 先查目标此刻是否在这个群里，再决定战报里算「踢出去」还是「提前拉黑」——
      // banChatMember 本身对两种情况效果一样（都会加入封禁名单），只是文案不能
      // 把「根本没进过的群」也说成踢出去了。
      const wasMember: boolean = await isChatMember(targetChatId, targetUser.id);
      const banned: boolean = await banChatMember(targetChatId, targetUser.id);
      if (!banned) return "failed";
      if (wasMember) recordUserConfirmedKickedInChat(targetChatId, targetUser.id);
      return wasMember ? "kicked" : "preBanned";
    })
  );
  const cleanupPromise: Promise<SenderChatReplyCleanupOutcome> =
    cleanupSenderChatReply({
      chatId,
      commandMessage: ctx.msg,
      targetUser,
      isAdminHere,
    });
  const [perChatOutcomes, cleanupOutcome]: [
    ("kicked" | "preBanned" | "failed")[],
    SenderChatReplyCleanupOutcome
  ] = await Promise.all([perChatOutcomesPromise, cleanupPromise]);
  const cleanupNote: string = senderChatCleanupNote(cleanupOutcome);
  for (let index: number = 0; index < perChatOutcomes.length; index++) {
    const outcome: "kicked" | "preBanned" | "failed" | undefined = perChatOutcomes[index];
    if (outcome === "kicked") kickedCount++;
    else if (outcome === "preBanned") preBannedCount++;
    else resweepChatIds.push(targetChatIds[index]!);
  }
  // 权限恢复后由下一次管理员身份观测把这些群重扫一遍，不用管理员再跑一次 /block。
  for (const resweepChatId of resweepChatIds) requestBlocklistResweep(resweepChatId);

  const bannedCount: number = kickedCount + preBannedCount;
  if (bannedCount === 0) {
    const replyText: string = `呜……${targetLabel} 居然一个群都踢不动，是本天才没有封禁权限吧？杂鱼管理员快去检查——不过 TA 已经记进小本本了${persistWarning}，再进群就秒踢${cleanupNote}♡`;
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
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
  // 本来就在名单里的人再 /block 一次不该被说成「刚记上」。各群仍重新处置，
  // 但当天已经确证踢出的 `(chatId, userId)` 可命中命令侧缓存；新加的群、上次
  // 失败或只做过预封禁的群仍会真正查、封。落盘警告两条路都要带：重复 /block
  // 正是上一次没写进硬盘时的重试动作，还没写成功就不能不说。
  const blocklistNote: string = newlyBlocked
    ? `，杂鱼永远别想回来了${persistWarning}`
    : `（早就在小本本上了${persistWarning}）`;
  await sendCommandMessage({
    chatId,
    text: `${notAdminHereNote}哼，${targetLabel} 被本天才${actionNote}${failedNote}${blocklistNote}${cleanupNote}♡`,
    replyToMessageId: messageId,
  });
}
