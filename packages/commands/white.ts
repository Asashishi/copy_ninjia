import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { SetWhitelistMembershipResult } from "../types/whitelist";
import { setWhitelistMembership } from "../config/whitelist";
import { sendMessage } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { isSuperAdminActor, resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

type WhiteAction = "enable" | "disable";

/** /white 的固定用法；动作始终放在最后，回复目标时可省略身份参数。 */
const WHITE_USAGE_TEXT: string =
  `笨蛋，用法是 /white <用户id|频道id|@username> <enable|disable>；` +
  `回复目标消息时只写 /white <enable|disable> 就行啦♡`;

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
 * 已经授予的字段；disable 删除整条身份及其全部逐项权限。
 */
export async function handleWhiteCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!isSuperAdminActor(ctx)) {
    const actor: CachedUser | undefined = resolveCommandActor(ctx);
    await sendMessage({
      chatId,
      text: `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想改本天才的白名单？哪来的资格呀，笨蛋♡`,
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
    await sendMessage({
      chatId,
      text: WHITE_USAGE_TEXT,
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
    messages: {
      missingTarget: `笨蛋，要回复一条用户或频道消息，或者把 @username、用户/频道 id 写在 /white 后面呀♡`,
      invalidUsername: (rawArgument: string): string =>
        `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户/频道 id♡`,
      unknownUsername: (rawUsername: string): string =>
        `笨蛋，@${rawUsername} 还没被本天才记住；回复 TA 的消息或直接给 id 吧♡`,
      conflictingTarget: (rawArgument: string): string =>
        `笨蛋，你回复了一个身份、又写了 ${rawArgument}，本天才才不替你猜要改谁♡`,
      selfTarget: `笨蛋，本天才自己才不用塞进白名单里呀♡`,
    },
  });
  if (target === undefined) return;

  const enabled: boolean = action === "enable";
  const result: SetWhitelistMembershipResult = await setWhitelistMembership({
    id: target.id,
    enabled,
  });
  const targetLabel: string = formatTargetLabel(target);
  const replyText: string = enabled
    ? result.changed
      ? `哼，${targetLabel} 已经被本天才加进白名单啦，先赏 TA 一套默认权限♡`
      : `笨蛋，${targetLabel} 本来就在白名单里，已有权限当然不会被重置呀♡`
    : result.changed
      ? `哼，${targetLabel} 已经被本天才从白名单里踢出去啦♡`
      : `笨蛋，${targetLabel} 本来就不在白名单里，还想删什么呀♡`;
  await sendMessage({
    chatId,
    text: replyText,
    replyToMessageId: messageId,
  });
}
