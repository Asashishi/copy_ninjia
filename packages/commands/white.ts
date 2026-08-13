import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { SetWhitelistMembershipResult } from "../infra/identityPolicy/whitelist";
import {
  confirmWhitelistEntryPersisted,
  hasWhitelistPermission,
  setWhitelistMembership,
} from "../infra/identityPolicy/whitelist";
import { WHITE_COMMAND_TEXTS } from "../consts/whitelist";
import { isUserBlocked } from "../infra/blocklist/membership";
import { SUPER_ADMIN_USER_ID } from "../config/telegram";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { identityMetadataFromCachedUser } from "../infra/identityStorage";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

type WhiteAction = "enable" | "disable";

type WhiteMutationOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "updated"; readonly result: SetWhitelistMembershipResult };

/** 大小写不敏感地解析成员关系动作，拒绝其它近似写法。 */
export function parseWhiteAction(raw: string): WhiteAction | undefined {
  const normalized: string = raw.toLowerCase();
  if (normalized === "enable" || normalized === "disable") return normalized;
  return undefined;
}

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
 * 当前群自己的 identity 一律拒绝（匿名管理员皮套），理由见函数体那道闸。
 */
export async function handleWhiteCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const actorIsSuperAdmin: boolean = actor?.id === SUPER_ADMIN_USER_ID;
  const actorCanWhiteOther: boolean = actorIsSuperAdmin || (
    actor !== undefined &&
    hasWhitelistPermission(actor.id, "isCanWhiteOther")
  );
  if (!actorCanWhiteOther) {
    await sendCommandMessage({
      chatId,
      text: WHITE_COMMAND_TEXTS.rejection(
        actor ? formatUserLabel(actor) : "哪个杂鱼"
      ),
      replyToMessageId: messageId,
    });
    return;
  }

  const tokens: string[] = ctx.match.trim()
    .split(/\s+/)
    .filter((token: string): boolean => token.length > 0);
  const rawAction: string | undefined = tokens.at(-1);
  const action: WhiteAction | undefined = rawAction === undefined
    ? undefined
    : parseWhiteAction(rawAction);
  if (action === undefined) {
    await sendCommandMessage({
      chatId,
      text: WHITE_COMMAND_TEXTS.usage,
      replyToMessageId: messageId,
    });
    return;
  }
  if (!actorIsSuperAdmin && action === "disable") {
    await sendCommandMessage({
      chatId,
      text: WHITE_COMMAND_TEXTS.delegatedDisableRejection,
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
    messages: WHITE_COMMAND_TEXTS.target,
  });
  if (target === undefined) return;

  // 与 /block（commands/block.ts）、/unblock（commands/unblock.ts）同一道闸：
  // 匿名管理员拿当前群当皮套时 Telegram 只给 sender_chat=本群，
  // resolveCommandTarget 按设计原样返回这个群自己的 identity（理由见
  // targetResolution.ts 结尾）。这里必须自己拒绝——把群 identity 写进白名单，
  // isWhitelisted 会对该群匿名身份发的每一条消息成立（广告检测与永久拉黑一律
  // 豁免，见 antiRaid/memberFacts.ts），随后 /permission <群 id> all 还能把
  // /block、/mute 和各功能开关交给这个群的任意匿名管理员。开了 acceptChatId
  // 之后这道闸同时守住「把本群 id 直接粘进参数」那种手滑。
  if (target.isChannel === true && target.id === chatId) {
    await sendCommandMessage({
      chatId,
      text: WHITE_COMMAND_TEXTS.currentChatTarget,
      replyToMessageId: messageId,
    });
    return;
  }

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
      text: WHITE_COMMAND_TEXTS.superAdminEnable,
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
        if (
          !actorIsSuperAdmin &&
          (actor === undefined ||
            !hasWhitelistPermission(actor.id, "isCanWhiteOther"))
        ) {
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
      text: WHITE_COMMAND_TEXTS.mutationFailed,
      replyToMessageId: messageId,
    });
    return;
  }
  if (outcome.kind === "unauthorized") {
    await sendCommandMessage({
      chatId,
      text: WHITE_COMMAND_TEXTS.rejection(
        actor ? formatUserLabel(actor) : "哪个杂鱼"
      ),
      replyToMessageId: messageId,
    });
    return;
  }
  if (outcome.kind === "blocked") {
    await sendCommandMessage({
      chatId,
      text: WHITE_COMMAND_TEXTS.blocked(formatTargetLabel(target)),
      replyToMessageId: messageId,
    });
    return;
  }
  const result: SetWhitelistMembershipResult = outcome.result;
  const targetLabel: string = formatTargetLabel(target);
  // 超级管理员只可能走到 disable 这一支（enable 上面已经拒了）。它删掉的只是
  // 表里的历史残留：isWhitelisted 与 getEffectiveWhitelistPermissions 对
  // SUPER_ADMIN_USER_ID 是无条件的（见 whitelist.ts），删完再
  // /permission query 仍会打印全开。因此这一支必须有自己的回执，不能说成
  // 「已经从白名单里踢出去啦」。
  const replyText: string = isSuperAdminTarget
    ? result.changed
      ? WHITE_COMMAND_TEXTS.superAdminDisableCleared
      : WHITE_COMMAND_TEXTS.superAdminDisableNoEntry
    : enabled
      ? result.changed
        ? WHITE_COMMAND_TEXTS.enabled(targetLabel)
        : WHITE_COMMAND_TEXTS.alreadyEnabled(targetLabel)
      : result.changed
        ? WHITE_COMMAND_TEXTS.disabled(targetLabel)
        : WHITE_COMMAND_TEXTS.alreadyDisabled(targetLabel);
  await sendCommandMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
