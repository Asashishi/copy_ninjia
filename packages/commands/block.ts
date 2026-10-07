import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { ToggleAction } from "../types/commands";
import {
  sendCommandMessage,
  banChatMember,
  banChatSenderChat,
} from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";

import { resolveCommandTarget } from "./targetResolution";
import { parseToggleAction, splitTrailingToken } from "./arguments";
import type { TrailingTokenSplit } from "./arguments";
import { handleBlockDisable } from "./unblock";
import { rejectUnlessPermitted } from "./commandActor";
import { botCanRestrictMembersIn, botChatPermissionsIn } from "../infra/botAdmin";
import { describeBotPermissionGap } from "../libs/botPermissionGap";
import type { BotChatPermissions } from "../types/telegram";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { identityMetadataFromCachedUser } from "../infra/identityStorage";
import {
  blockUser,
  confirmBlocklistPersisted,
  managedAdminChatIds,
  runManagedChatBatch,
} from "../infra/blocklist/membership";
import type { ManagedChatOutcome } from "../infra/blocklist/membership";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { runBlocklistFanOut } from "./blocklistFanOut";

interface BlockAdmission {
  readonly protected: boolean;
  readonly newlyBlocked: boolean;
}

/**
 * `/block <目标> enable`：把目标写进持久化黑名单，并在所有机器人是管理员的群里
 * 同时封禁（直接 ban，不同于入群验证与反刷群的自动踢出）。封禁对还没加入的群同样
 * 生效；每群只发一次封禁请求，封禁前不查询目标是否在群，战报只报封禁成功与失败的
 * 群数。群清单来自 infra/blocklist/membership.ts 的 managedAdminChatIds（各群
 * ChatState.botPermissions.isAdministrator，见 infra/botAdmin.ts）；权限快照已确证
 * 缺「限制与封禁成员」的群不发请求，直接计为失败。机器人在发起命令的这个群里不是
 * 管理员时，本群不在清单内，其它受管群照常封禁，回复里说明本群没封；清单为空时只
 * 回执名单写入结果（blockNoManagedChat）。
 *
 * 名单写入与落盘确认在本条 update 内完成；跨群封禁与战报交给延迟命令执行器的后台档
 * （见 ./blocklistFanOut.ts），update runner 不等各群的 Telegram 请求。
 *
 * 黑名单先于封禁写入，与封禁结果无关；之后这个 id 出现在任何监听群的入群更新里都会
 * 被秒踢（见 antiRaid/blocklistGuard.ts），名单由 DiskIO Worker 持久化到
 * database/storage.sqlite（见 infra/identityStorage.ts）。
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

  // 保留整份权限快照：本群没封时，回执据它说明原因（见 describeBotPermissionGap）。
  const herePermissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  const isAdminHere: boolean = herePermissions?.isAdministrator === true;

  // 目标解析与 /copy 共用冲突校验；额外接受裸用户 id。
  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    // 自己人闸与 blockUser 都读目标的名单结论，预热失败时拒绝执行。
    requireIdentityPolicies: true,
    // 拒绝目标为当前群自己的 identity（匿名管理员皮套）：Telegram 只提供
    // sender_chat=当前群，不暴露真实用户，封禁只会落在群组身份上。
    currentChatTargetText: chatAtmosphere().NOTICE_TEXTS.blockCurrentChat,
    messages: chatAtmosphere().BLOCK_TARGET_TEXTS,
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
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId,
      text: atmosphere.NOTICE_TEXTS.blockProtected(formatTargetLabel(targetUser, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }

  // 黑名单先写、与封禁结果无关：先发布 LRU 最终值，再把 revision 投给 DiskIO Worker；
  // 重复 /block 同一个人时 blockUser 返回 false，不创建新 revision。
  const newlyBlocked: boolean = admission.newlyBlocked;
  // 等待该 id 最新 revision 的事务 ACK；重复 /block 时若最新 revision 尚未 ACK，先把同一
  // 最终值重投给当前 Worker（不创建新 revision）再等待。
  const persisted: boolean = await confirmBlocklistPersisted(targetUser.id, !newlyBlocked);

  // 封禁清单与 /block disable 的跨群解封同源，见 infra/blocklist/membership.ts 的 managedAdminChatIds。
  const targetChatIds: number[] = managedAdminChatIds(chatId, isAdminHere);

  // 无跨群操作时直接渲染本次落盘结果。
  if (targetChatIds.length === 0) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
    const persistWarning: string = persisted ? "" : atmosphere.NOTICE_TEXTS.blockPersistFailed;
    await sendCommandMessage({
      chatId,
      text: atmosphere.NOTICE_TEXTS.blockNoManagedChat(targetLabel, persistWarning),
      replyToMessageId: messageId,
    });
    return;
  }

  // 跨群封禁与战报交给延迟命令执行器的后台档（见 ./blocklistFanOut.ts）。
  await runBlocklistFanOut({
    identityId: targetUser.id,
    errorLabel: "Unexpected error while banning a /block target across chats:",
    fanOut: (): Promise<void> => banEverywhereAndReport({
      chatId,
      messageId,
      targetUser,
      targetChatIds,
      herePermissions,
      isAdminHere,
      newlyBlocked,
      persisted,
    }),
  });
}

/** banEverywhereAndReport 的入参：handler 已完成校验与名单落盘后的全部事实。 */
interface BanEverywhereParams {
  readonly chatId: number;
  readonly messageId: number | undefined;
  readonly targetUser: CachedUser;
  readonly targetChatIds: readonly number[];
  readonly herePermissions: BotChatPermissions | undefined;
  readonly isAdminHere: boolean;
  readonly newlyBlocked: boolean;
  readonly persisted: boolean;
}

/** 在全部受管群封禁目标，失败群重新欠一次补扫，最后在发起群发战报。 */
async function banEverywhereAndReport({
  chatId,
  messageId,
  targetUser,
  targetChatIds,
  herePermissions,
  isAdminHere,
  newlyBlocked,
  persisted,
}: BanEverywhereParams): Promise<void> {
  let bannedCount: number = 0;
  // 扇出与逐项结算收在 runManagedChatBatch，与 `/block disable` 的跨群解封共用同一份
  // 清单和同一个并发上限（见 infra/blocklist/membership.ts）。
  const perChatOutcomes: readonly ManagedChatOutcome<boolean>[] =
    await runManagedChatBatch<boolean>({
      chatIds: targetChatIds,
      action: `ban blocked identity ${targetUser.id}`,
      onUnexpectedFailure: false,
      execute: (targetChatId: number): Promise<boolean> => {
        // 快照已确证缺「限制与封禁成员」的群不发请求，计为失败；快照未知时照常发，
        // 由 Telegram 裁决（见 infra/botAdmin.ts 的 botCanRestrictMembersIn）。
        if (botCanRestrictMembersIn(targetChatId) === false) return Promise.resolve(false);
        // 每次 /block 都对每个群重新封禁；频道马甲（sender_chat）由 banChatSenderChat
        // 限制它在本群的发言。
        return targetUser.isChannel === true
          ? banChatSenderChat(targetChatId, targetUser.id)
          : banChatMember(targetChatId, targetUser.id);
      },
    });
  // 结算保留 chatId 且与输入同序，单群异常不影响其它群的结果。封禁失败的群经
  // requestBlocklistResweep 重新登记补扫（见 infra/blocklist/sweep.ts），权限恢复后由
  // 下一次管理员身份观测重扫。
  for (const outcome of perChatOutcomes) {
    if (outcome.value) bannedCount++;
    else requestBlocklistResweep(outcome.chatId);
  }

  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
  const persistWarning: string = persisted ? "" : atmosphere.NOTICE_TEXTS.blockPersistFailed;
  if (bannedCount === 0) {
    const replyText: string = atmosphere.NOTICE_TEXTS.blockAllFailed(targetLabel, persistWarning);
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  // 本群没进清单时说明本群没封，原因由 describeBotPermissionGap 按权限快照给出
  // （见 libs/botPermissionGap.ts）。
  const hereGap: string | undefined = isAdminHere
    ? undefined
    : describeBotPermissionGap(herePermissions, "canRestrictMembers", atmosphere.NOTICE_TEXTS);
  const skippedHereNote: string = hereGap === undefined ? "" : atmosphere.NOTICE_TEXTS.blockSkippedHere(hereGap);
  const failedCount: number = targetChatIds.length - bannedCount;
  const failedNote: string = failedCount > 0 ? atmosphere.NOTICE_TEXTS.blockPartialFailure(failedCount) : "";
  // 已在名单里的目标再 /block 用 blockAlreadyRecorded，各群照样重新封禁；
  // 落盘警告两条路径都附带。
  const blocklistNote: string = newlyBlocked
    ? atmosphere.NOTICE_TEXTS.blockRecorded(persistWarning)
    : atmosphere.NOTICE_TEXTS.blockAlreadyRecorded(persistWarning);
  await sendCommandMessage({
    chatId,
    text: atmosphere.NOTICE_TEXTS.blockResult({ skippedHereNote, targetLabel, bannedCount, failedNote, blocklistNote }),
    replyToMessageId: messageId,
  });
}

/**
 * 处理 /block：动作放在末位，与 /white 同一口径——`/block <目标> enable` 拉黑、
 * `/block <目标> disable` 解除（commands/unblock.ts），回复目标时只写动作。动作缺省
 * 或不是 enable/disable 时回用法提示；两个动作各自校验权限
 * （isCanBlock / isCanUnBlock）。
 */
export async function handleBlockCommand(ctx: CommandContext<Context>): Promise<void> {
  const { last: rawAction, rest: targetArgument }: TrailingTokenSplit = splitTrailingToken(ctx.match);
  const action: ToggleAction | undefined = rawAction === undefined ? undefined : parseToggleAction(rawAction);
  if (action === undefined) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere().NOTICE_TEXTS.blockUsage,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (action === "enable") await blockTarget(ctx, targetArgument);
  else await handleBlockDisable(ctx, targetArgument);
}
