import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { ToggleAction } from "../types/commands";
import type { SetWhitelistMembershipResult } from "../infra/identityPolicy/whitelist";
import {
  confirmWhitelistEntryPersisted,
  hasWhitelistPermission,
  setWhitelistMembership,
} from "../infra/identityPolicy/whitelist";

import { commandArgumentTokens, parseToggleAction } from "./arguments";
import { isUserBlocked } from "../infra/blocklist/membership";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { identityMetadataFromCachedUser } from "../infra/identityStorage";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatActorLabel, formatTargetLabel } from "../users/userLabel";
import { rejectUnlessPermitted } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

type WhiteMutationOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "updated"; readonly result: SetWhitelistMembershipResult };

/**
 * 处理 /white：超级管理员可新增或删除；持有 isCanWhiteOther 的普通白名单身份
 * 只能新增，且新增路径固定写入完整默认权限，不能选择或继承发起人的权限。
 *
 * enable 只在身份不存在时写入完整默认权限，重复执行不会覆盖 /permission
 * 已经授予的字段；disable 删除整条身份及其全部逐项权限。两个方向都会如实
 * 区分「真的改了」与「本来就是这样」。
 *
 * 以超级管理员为目标时两个方向不对称：enable 被拒（他恒在白名单边界内，写进去
 * 的条目永远读不到），disable 照常放行——那正是清掉旧部署遗留条目的路径，但它
 * 的回执只能说「清掉了表里的残留」，不能说成「已经踢出白名单」。
 *
 * 当前群自己的 identity 一律拒绝（匿名管理员皮套），见函数体那道闸。
 */
export async function handleWhiteCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanWhiteOther",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.WHITE_COMMAND_TEXTS.rejection(actorLabel)
  );
  if (actor === undefined) return;
  const actorIsSuperAdmin: boolean = actor.id === SUPER_ADMIN_USER_ID;

  const tokens: string[] = commandArgumentTokens(ctx.match);
  const rawAction: string | undefined = tokens.at(-1);
  const action: ToggleAction | undefined = rawAction === undefined
    ? undefined
    : parseToggleAction(rawAction);
  if (action === undefined) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.usage,
      replyToMessageId: messageId,
    });
    return;
  }
  if (!actorIsSuperAdmin && action === "disable") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.delegatedDisableRejection,
      replyToMessageId: messageId,
    });
    return;
  }

  const targetArgument: string = tokens.slice(0, -1).join(" ");
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    acceptChatId: true,
    // 黑名单互斥判定与成员关系写入都读目标的名单结论。
    requireIdentityPolicies: true,
    // 与 /block（commands/block.ts）、/block disable（commands/unblock.ts）同一道闸：
    // 匿名管理员拿当前群当皮套时 Telegram 只给 sender_chat=本群，
    // resolveCommandTarget 按设计原样返回这个群自己的 identity（见
    // targetResolution.ts 的 currentChatTargetText）。这里必须拒绝——把群 identity
    // 写进白名单，isWhitelisted 会对该群匿名身份发的每一条消息成立（广告检测与
    // 永久拉黑一律豁免，见 antiRaid/memberFacts.ts），随后 /permission <群 id> all
    // 还能把 /block、/mute 和各功能开关交给这个群的任意匿名管理员。开了
    // acceptChatId 之后这道闸同时守住「把本群 id 直接粘进参数」那种手滑。
    currentChatTargetText: chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.currentChatTarget,
    messages: chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.target,
  });
  if (target === undefined) return;

  const enabled: boolean = action === "enable";
  // 超级管理员恒在白名单边界内、且恒持有全部权限（见 whitelist.ts），
  // enable 只会往 SQLite 写一条永远读不到的条目，换过 SUPER_ADMIN_USER_ID
  // 之后还会留成全开的旧身份。disable 反过来仍然放行：它只是清掉表里的
  // 历史残留，清完超级管理员本人的权限一点不受影响——正因如此，那条路的回执
  // 也不能沿用 disabled 那句「已经踢出白名单」，见下面的 superAdminDisable*。
  const isSuperAdminTarget: boolean = target.id === SUPER_ADMIN_USER_ID;
  if (enabled && isSuperAdminTarget) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.superAdminEnable,
      replyToMessageId: messageId,
    });
    return;
  }
  // 编码、互斥、DiskIO 投递或事务确认异常时就地回执，避免让一条管理员命令经
  // acknowledged runner 进入无休止重投。已发布的 LRU 最终值与未 ACK revision
  // 会留在主线程，并在幂等重试或 DiskIO Worker 重建后重放；成功文案则必须等
  // 本命令自己的单领域 flush 与精确 ACK。
  let outcome: WhiteMutationOutcome;
  try {
    outcome = await runProtectedIdentityMutation(
      (): WhiteMutationOutcome => {
        // 授权与成员关系写入在同一个同步临界区线性化：目标解析或前序策略修改
        // 等待期间，超级管理员可能已经撤掉发起人的 isCanWhiteOther，不能沿用
        // handler 入口那份陈旧快照继续扩张白名单。
        if (!hasWhitelistPermission(actor.id, "isCanWhiteOther")) {
          return { kind: "unauthorized" };
        }
        if (enabled && isUserBlocked(target.id)) return { kind: "blocked" };
        return {
          kind: "updated",
          result: setWhitelistMembership({
            id: target.id,
            enabled,
            meta: enabled ? identityMetadataFromCachedUser(target) : undefined,
          }),
        };
      }
    );
    if (outcome.kind === "updated") {
      await confirmWhitelistEntryPersisted(
        target.id,
        !outcome.result.changed
      );
    }
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist membership change for identity ${target.id}:`,
      error
    );
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.mutationFailed,
      replyToMessageId: messageId,
    });
    return;
  }
  if (outcome.kind === "unauthorized") {
    const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
    await sendCommandMessage({
      chatId,
      text: atmosphere.WHITE_COMMAND_TEXTS.rejection(formatActorLabel(actor, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }
  if (outcome.kind === "blocked") {
    const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
    await sendCommandMessage({
      chatId,
      text: atmosphere.WHITE_COMMAND_TEXTS.blocked(formatTargetLabel(target, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }
  const result: SetWhitelistMembershipResult = outcome.result;
  const targetLabel: string = formatTargetLabel(target, chatAtmosphere(chatId));
  // 超级管理员只可能走到 disable 这一支（enable 上面已经拒了）。它删掉的只是
  // 表里的历史残留：isWhitelisted 与 getEffectiveWhitelistPermissions 对
  // SUPER_ADMIN_USER_ID 是无条件的（见 whitelist.ts），删完再
  // /permission query 仍会打印全开。因此这一支必须有自己的回执，不能说成
  // 「已经从白名单里踢出去啦」。
  const replyText: string = isSuperAdminTarget
    ? result.changed
      ? chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.superAdminDisableCleared
      : chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.superAdminDisableNoEntry
    : enabled
      ? result.changed
        ? chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.enabled(targetLabel)
        : chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.alreadyEnabled(targetLabel)
      : result.changed
        ? chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.disabled(targetLabel)
        : chatAtmosphere(chatId).WHITE_COMMAND_TEXTS.alreadyDisabled(targetLabel);
  await sendCommandMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
