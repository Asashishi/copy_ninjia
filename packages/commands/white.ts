import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { ToggleAction } from "../types/commands";
import type { SetWhitelistMembershipResult } from "../infra/identityPolicy/whitelist";
import {
  hasWhitelistPermission,
  setWhitelistMembership,
} from "../infra/identityPolicy/whitelist";

import { parseToggleAction, splitTrailingToken } from "./arguments";
import type { TrailingTokenSplit } from "./arguments";
import { isUserBlocked } from "../infra/blocklist/membership";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { confirmIdentityPolicyPersisted, identityMetadataFromCachedUser } from "../infra/identityStorage";
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
 * 以超级管理员为目标时两个方向不对称：enable 被拒（他恒在白名单边界内）；
 * disable 照常放行，清掉表里的残留条目，回执为 superAdminDisableCleared 或
 * superAdminDisableNoEntry。
 *
 * 目标是当前群自己的 identity（匿名管理员皮套）时拒绝，见 resolveCommandTarget
 * 的 currentChatTargetText。
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

  const { last: rawAction, rest: targetArgument }: TrailingTokenSplit = splitTrailingToken(ctx.match);
  const action: ToggleAction | undefined = rawAction === undefined
    ? undefined
    : parseToggleAction(rawAction);
  if (action === undefined) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().WHITE_COMMAND_TEXTS.usage,
      replyToMessageId: messageId,
    });
    return;
  }
  if (!actorIsSuperAdmin && action === "disable") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().WHITE_COMMAND_TEXTS.delegatedDisableRejection,
      replyToMessageId: messageId,
    });
    return;
  }

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
    // 目标解析得到当前群自己的 identity（匿名管理员皮套，或参数里粘贴了本群 id）时，
    // 发送 currentChatTargetText 并返回 undefined（见 targetResolution.ts 的
    // currentChatTargetText）。
    currentChatTargetText: chatAtmosphere().WHITE_COMMAND_TEXTS.currentChatTarget,
    messages: chatAtmosphere().WHITE_COMMAND_TEXTS.target,
  });
  if (target === undefined) return;

  const enabled: boolean = action === "enable";
  // 超级管理员恒在白名单边界内、且恒持有全部权限（见 whitelist.ts），
  // 对其 enable 直接拒绝；disable 放行，只清掉表里的残留条目，不影响其权限，
  // 回执见下面的 superAdminDisable*。
  const isSuperAdminTarget: boolean = target.id === SUPER_ADMIN_USER_ID;
  if (enabled && isSuperAdminTarget) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().WHITE_COMMAND_TEXTS.superAdminEnable,
      replyToMessageId: messageId,
    });
    return;
  }
  // 编码、互斥、DiskIO 投递或事务确认异常时就地回执 mutationFailed，不外抛。已发布的
  // LRU 最终值与未 ACK revision 留在主线程，在幂等重试或 DiskIO Worker 重建后重放；
  // 成功文案等本命令自己的单领域 flush 与精确 ACK。
  let outcome: WhiteMutationOutcome;
  try {
    outcome = await runProtectedIdentityMutation(
      (): WhiteMutationOutcome => {
        // 授权与成员关系写入在同一个同步临界区线性化：这里重新读取发起人的
        // isCanWhiteOther，不沿用 handler 入口的快照。
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
      await confirmIdentityPolicyPersisted("whitelist", target.id, !outcome.result.changed);
    }
  } catch (error: unknown) {
    logger.error(
      `Failed to persist the whitelist membership change for identity ${target.id}:`,
      error
    );
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().WHITE_COMMAND_TEXTS.mutationFailed,
      replyToMessageId: messageId,
    });
    return;
  }
  if (outcome.kind === "unauthorized") {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId,
      text: atmosphere.WHITE_COMMAND_TEXTS.rejection(formatActorLabel(actor, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }
  if (outcome.kind === "blocked") {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId,
      text: atmosphere.WHITE_COMMAND_TEXTS.blocked(formatTargetLabel(target, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }
  const result: SetWhitelistMembershipResult = outcome.result;
  const targetLabel: string = formatTargetLabel(target, chatAtmosphere());
  // 超级管理员只可能走到 disable 这一支（enable 上面已经拒绝）。删掉的只是表里的
  // 残留条目：isWhitelisted 与 getEffectiveWhitelistPermissions 对
  // SUPER_ADMIN_USER_ID 无条件成立（见 whitelist.ts），这一支使用自己的回执。
  const replyText: string = isSuperAdminTarget
    ? result.changed
      ? chatAtmosphere().WHITE_COMMAND_TEXTS.superAdminDisableCleared
      : chatAtmosphere().WHITE_COMMAND_TEXTS.superAdminDisableNoEntry
    : enabled
      ? result.changed
        ? chatAtmosphere().WHITE_COMMAND_TEXTS.enabled(targetLabel)
        : chatAtmosphere().WHITE_COMMAND_TEXTS.alreadyEnabled(targetLabel)
      : result.changed
        ? chatAtmosphere().WHITE_COMMAND_TEXTS.disabled(targetLabel)
        : chatAtmosphere().WHITE_COMMAND_TEXTS.alreadyDisabled(targetLabel);
  await sendCommandMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
