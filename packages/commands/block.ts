import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { ToggleAction } from "../types/commands";
import {
  sendCommandMessage,
  banChatMember,
  banChatSenderChat,
  isChatMember,
} from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";

import { resolveCommandTarget } from "./targetResolution";
import { commandArgumentTokens, parseToggleAction } from "./arguments";
import { handleBlockDisable } from "./unblock";
import { rejectUnlessPermitted } from "./commandActor";
import { botChatPermissionsIn } from "../infra/botAdmin";
import { describeBotPermissionGap } from "../libs/botPermissionGap";
import type { BotChatPermissions } from "../types/telegram";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { identityMetadataFromCachedUser } from "../infra/identityStorage";
import {
  blockUser,
  confirmBlocklistPersisted,
  ensureBlocklistEntryQueued,
  managedAdminChatIds,
  runManagedChatBatch,
} from "../infra/blocklist/membership";
import type { ManagedChatOutcome } from "../infra/blocklist/membership";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";

type PerChatBlockOutcome = "kicked" | "confirmedBanned" | "failed";

interface BlockAdmission {
  readonly protected: boolean;
  readonly newlyBlocked: boolean;
}

/**
 * `/block <目标> enable`：把目标写进持久化黑名单，并在所有「机器人是管理员」的群里
 * 同时封禁（与入群验证/反刷群的自动踢出不同——那些踢而不 ban 以防误杀，这里
 * 是管理员的手动判断，直接全网封死）。封禁对还没加入的群同样生效，目标之后
 * 也进不去，但那终究不是「踢」——战报文案按目标此刻是否在场分别措辞
 * （isChatMember）：真在场的算踢出去，不在场的只算确认封禁。群清单来自
 * 各群 ChatState.botPermissions.isAdministrator（见 infra/botAdmin.ts）。机器人在发起命令的这个群
 * 里不是管理员时，本群自然踢不了，但对其它管理的群的连坐封禁照常执行，只在
 * 回复里说明本群没踢；一个管理的群都没有才整体拒绝。
 *
 * 黑名单先于封禁写入，且即使一个群都没封成也照样保留：这两件事解决的不是
 * 同一个问题——封禁只覆盖此刻已知且有管理权的群，黑名单覆盖的是「以后」，
 * 包括机器人当时还没进、或还不是管理员的群。之后这个 id 出现在任何监听群的
 * 入群更新里都会被秒踢（见 antiRaid/blocklistGuard.ts），名单由 DiskIO Worker
 * 持久化到 database/storage.sqlite（见 infra/identityStorage.ts）。
 *
 * 目标支持回复消息、当前身份缓存中的用户名或裸用户 id；回复与参数同时给出时
 * 必须指向同一身份。裸 id 只接受正整数；频道目标由回复或用户名解析，随后走
 * banChatSenderChat 限制该频道身份的发言。仅限持有 isCanBlock 的用户或频道身份
 * 使用，权限与目标保护约束见 docs/cn/04-invariants.md。
 * @param targetArgument 去掉末位动作后的目标参数原文，可为空（此时只认回复目标）。
 */
async function blockTarget(ctx: CommandContext<Context>, targetArgument: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanBlock",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.blockRejected(actorLabel)
  );
  if (actor === undefined) return;

  // 语义见函数顶部说明（本群非管理员不影响其它群连坐）。快照整份留着，本群没踢时
  // 回执据它说清是没查清还是不是管理员。
  const herePermissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  const isAdminHere: boolean = herePermissions?.isAdministrator === true;

  // 目标解析与 /copy 共用冲突校验；额外接受裸用户 id。
  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    // 自己人闸与 blockUser 都读目标的名单结论，冷读失败时不能当成「不受保护」。
    requireIdentityPolicies: true,
    // 匿名管理员以当前群组身份发言时，Telegram 只提供 sender_chat=当前群，
    // 不会暴露皮套背后的真实用户。该身份在 /copy 中必须保留用于头像和复读；
    // 但 /block 若继续执行，只会尝试封禁整个群组身份，不能踢出那名管理员。
    currentChatTargetText: chatAtmosphere(chatId).NOTICE_TEXTS.blockCurrentChat,
    messages: chatAtmosphere(chatId).BLOCK_TARGET_TEXTS,
  });
  if (!targetUser) return;

  // 白名单保护检查与名单写入处于同一身份事务边界，受保护目标不进入封禁流程。
  const admission: BlockAdmission = await runProtectedIdentityMutation(
    (): BlockAdmission => {
      // isWhitelisted 已经把超级管理员算进白名单边界（whitelist.ts）。
      if (isWhitelisted(targetUser.id)) {
        return { protected: true, newlyBlocked: false };
      }
      return {
        protected: false,
        newlyBlocked: blockUser(
          targetUser.id,
          identityMetadataFromCachedUser(targetUser)
        ),
      };
    }
  );
  if (admission.protected) {
    const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
    await sendCommandMessage({
      chatId,
      text: atmosphere.NOTICE_TEXTS.blockProtected(formatTargetLabel(targetUser, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }

  // 黑名单先写、且与封禁结果无关：封禁只能覆盖此刻已知且有管理权的群，名单
  // 覆盖的是以后——包括机器人当时还没进的群。先发布 LRU 最终值，再把 revision
  // 投给 DiskIO Worker；重复 /block 同一个人时返回 false，不创建新 revision。
  const newlyBlocked: boolean = admission.newlyBlocked;
  // 只有真的新增了记录才值得等这一次落盘回执：没落盘就不能把「永久」说出口。
  // 重复 /block 时也要等：这个 id 若是本进程新增、上一次落盘又失败了，管理员
  // 修好磁盘再跑一次正是最自然的重试动作，不能因为「LRU 里已经有了」就静默
  // 跳过——那会连着两次都告诉他成功了，而数据库里根本没有这条记录。
  const requeued: boolean = newlyBlocked ? false : ensureBlocklistEntryQueued(targetUser.id);
  const persisted: boolean = newlyBlocked || requeued ? await confirmBlocklistPersisted() : true;

  // 封禁清单与 /block disable 的跨群解封同源，见 infra/blocklist/membership.ts 的 managedAdminChatIds。
  const targetChatIds: number[] = managedAdminChatIds(chatId, isAdminHere);

  // 无跨群操作时直接渲染本次落盘结果。
  if (targetChatIds.length === 0) {
    const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
    const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
    const persistWarning: string = persisted ? "" : atmosphere.NOTICE_TEXTS.blockPersistFailed;
    await sendCommandMessage({
      chatId,
      text: atmosphere.NOTICE_TEXTS.blockNoManagedChat(targetLabel, persistWarning),
      replyToMessageId: messageId,
    });
    return;
  }

  // 频道马甲（sender_chat）没有「成员」这个概念，banChatSenderChat 本来就
  // 只是拉黑发言权，不存在「把它踢出去」一说，一律算封禁，不查成员状态。
  let kickedCount: number = 0;
  let confirmedBannedCount: number = 0;
  // 封禁失败的群要重新欠一次补扫：这个群若早就扫过，sweptAt 那道闩锁会让它
  // 永不重扫，而入群秒踢只对之后的入群更新生效——被拉黑的人就这么在那个群里
  // 待到进程结束（见 infra/blocklist/ 的 requestBlocklistResweep）。
  const resweepChatIds: number[] = [];
  // 群内那两步是真实依赖（先查在不在，再封），群与群之间不是；扇出与逐项结算
  // 收在 runManagedChatBatch，与 `/block disable` 的跨群解封共用同一份清单和同一个
  // 并发上限（见 infra/blocklist/membership.ts）。
  const perChatOutcomes: readonly ManagedChatOutcome<PerChatBlockOutcome>[] =
    await runManagedChatBatch<PerChatBlockOutcome>({
      chatIds: targetChatIds,
      action: `ban blocked identity ${targetUser.id}`,
      onUnexpectedFailure: "failed",
      execute: async (targetChatId: number): Promise<PerChatBlockOutcome> => {
        if (targetUser.isChannel) {
          return await banChatSenderChat(targetChatId, targetUser.id)
            ? "confirmedBanned"
            : "failed";
        }
        // `/block` 是低频管理员命令，每次都取 Telegram 当前成员状态并重新封禁；
        // 不缓存历史“踢出”结局，避免 `/block disable`、外部管理员解封或重新入群后
        // 读到过期事实。
        const wasMember: boolean = await isChatMember(targetChatId, targetUser.id);
        const banned: boolean = await banChatMember(targetChatId, targetUser.id);
        if (!banned) return "failed";
        return wasMember ? "kicked" : "confirmedBanned";
      },
    });
  // 结算保留原 chatId 且与输入同序，单群异常不会吞掉其它已经落定的封禁。
  for (const outcome of perChatOutcomes) {
    if (outcome.value === "kicked") kickedCount++;
    else if (outcome.value === "confirmedBanned") confirmedBannedCount++;
    else resweepChatIds.push(outcome.chatId);
  }
  // 权限恢复后由下一次管理员身份观测把这些群重扫一遍，不用管理员再跑一次 /block。
  for (const resweepChatId of resweepChatIds) requestBlocklistResweep(resweepChatId);

  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
  const persistWarning: string = persisted ? "" : atmosphere.NOTICE_TEXTS.blockPersistFailed;
  const bannedCount: number = kickedCount + confirmedBannedCount;
  if (bannedCount === 0) {
    const replyText: string = atmosphere.NOTICE_TEXTS.blockAllFailed(targetLabel, persistWarning);
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  // 本群没进清单时明确说清：本群这个人还留着，被拉黑的是其它群；原因按快照三态说
  // （见 libs/botPermissionGap.ts），查不到不说成不是管理员。
  const hereGap: string | undefined = isAdminHere
    ? undefined
    : describeBotPermissionGap(herePermissions, "canRestrictMembers", atmosphere.NOTICE_TEXTS);
  const skippedHereNote: string = hereGap === undefined ? "" : atmosphere.NOTICE_TEXTS.blockSkippedHere(hereGap);
  const failedCount: number = targetChatIds.length - bannedCount;
  const failedNote: string = failedCount > 0 ? atmosphere.NOTICE_TEXTS.blockPartialFailure(failedCount) : "";
  // “不在群”只表示本次没有执行移出动作，无法证明目标从未加入过；因此只说
  // “确认封禁”，不再使用“提前拉黑（根本没进去过）”这类历史推断。
  const kickedNote: string = kickedCount > 0 ? atmosphere.NOTICE_TEXTS.blockKicked(kickedCount) : "";
  const confirmedBannedNote: string = confirmedBannedCount > 0 ? `在 ${confirmedBannedCount} 个群确认封禁` : "";
  const actionNote: string = [kickedNote, confirmedBannedNote].filter(Boolean).join("，");
  // 本来就在名单里的人再 /block 一次不该被说成「刚记上」。各群仍重新查询
  // 成员状态并封禁，让外部解封或重新入群后的当前状态得到重新结算。
  // 落盘警告两条路都要带：重复 /block 正是上一次没写进硬盘时的重试动作，
  // 还没写成功就不能不说。
  const blocklistNote: string = newlyBlocked
    ? atmosphere.NOTICE_TEXTS.blockRecorded(persistWarning)
    : atmosphere.NOTICE_TEXTS.blockAlreadyRecorded(persistWarning);
  await sendCommandMessage({
    chatId,
    text: atmosphere.NOTICE_TEXTS.blockResult({ skippedHereNote, targetLabel, actionNote, failedNote, blocklistNote }),
    replyToMessageId: messageId,
  });
}

/**
 * 处理 /block：动作放在末位，与 /white 同一口径——`/block <目标> enable` 拉黑、
 * `/block <目标> disable` 解除（commands/unblock.ts），回复目标时只写动作。动作缺省
 * 或不是 enable/disable 时回用法提示（30 秒删除）；两个动作各自校验权限
 * （isCanBlock / isCanUnBlock）。
 */
export async function handleBlockCommand(ctx: CommandContext<Context>): Promise<void> {
  const tokens: string[] = commandArgumentTokens(ctx.match);
  const rawAction: string | undefined = tokens.at(-1);
  const action: ToggleAction | undefined = rawAction === undefined ? undefined : parseToggleAction(rawAction);
  if (action === undefined) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat.id).NOTICE_TEXTS.blockUsage,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  const targetArgument: string = tokens.slice(0, -1).join(" ");
  if (action === "enable") await blockTarget(ctx, targetArgument);
  else await handleBlockDisable(ctx, targetArgument);
}
