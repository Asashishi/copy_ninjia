import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { SetWhitelistMembershipResult } from "../types/whitelist";
import { setWhitelistMembership } from "../config/whitelist";
import { WHITE_COMMAND_TEXTS } from "../consts/whitelist";
import { isUserBlocked } from "../infra/blocklist/membership";
import { SUPER_ADMIN_USER_ID } from "../config/telegram";
import { runProtectedIdentityMutation } from "../infra/identityPolicy";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { isSuperAdminActor, resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

type WhiteAction = "enable" | "disable";

type WhiteMutationOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "updated"; readonly result: SetWhitelistMembershipResult };

/** 大小写不敏感地解析成员关系动作，拒绝其它近似写法。 */
export function parseWhiteAction(raw: string): WhiteAction | undefined {
  const normalized: string = raw.toLowerCase();
  if (normalized === "enable" || normalized === "disable") return normalized;
  return undefined;
}

/**
 * 处理 /white：仅超级管理员可新增或删除白名单身份。
 *
 * enable 只在身份不存在时写入完整默认权限，重复执行不会覆盖 /permission
 * 已经授予的字段；disable 删除整条身份及其全部逐项权限。两个方向都会如实
 * 区分「真的改了」与「本来就是这样」。
 *
 * 以超级管理员为目标时两个方向不对称：enable 被拒（他恒在白名单边界内，写进去
 * 的条目永远读不到），disable 照常放行——那正是清掉旧部署遗留条目的路径，但它
 * 的回执只能说「清掉了文件里的残留」，不能说成「已经踢出白名单」。
 *
 * 当前群自己的 identity 一律拒绝（匿名管理员皮套），理由见函数体那道闸。
 */
export async function handleWhiteCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!isSuperAdminActor(ctx)) {
    const actor: CachedUser | undefined = resolveCommandActor(ctx);
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
  // 超级管理员恒在白名单边界内、且恒持有全部权限（见 config/whitelist.ts），
  // enable 只会往部署配置里写一条永远读不到的条目，换过 SUPER_ADMIN_USER_ID
  // 之后还会留成全开的旧身份。disable 反过来仍然放行：它只是清掉文件里的
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
  // 写盘失败就地降级。这条命令的写入方是部署配置文件，config/ 不可写时
  // atomicWriteText 会抛 EACCES/ENOSPC；让它逸出 handler 的话 bot.catch 按设计
  // 原样重抛，acknowledged runner 随即让整个进程带非零码退出且不确认 offset，
  // Telegram 重投同一条命令 —— 一条 /white 就能把机器人锁进永久重启循环。
  // 名单此刻一点没改（commitWhitelistMutation 只在写盘成功后发布），因此确认
  // 这条 update 是安全的，回执如实说「没写进硬盘」即可。
  let outcome: WhiteMutationOutcome;
  try {
    outcome = await runProtectedIdentityMutation(
      async (): Promise<WhiteMutationOutcome> => {
        if (enabled && isUserBlocked(target.id)) return { kind: "blocked" };
        return {
          kind: "updated",
          result: await setWhitelistMembership({ id: target.id, enabled }),
        };
      }
    );
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
  // 文件里的历史残留：isWhitelisted 与 getEffectiveWhitelistPermissions 对
  // SUPER_ADMIN_USER_ID 是无条件的（见 config/whitelist.ts），删完再
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
