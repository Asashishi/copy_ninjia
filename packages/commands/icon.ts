import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";

import { ICON_SUBCOMMAND_PATTERN } from "../consts/icon";
import type { CachedUser } from "../types/chatState";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { CopyCooldownClaim } from "../types/copy/cooldown";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { queueAvatarUpdate } from "../copy/avatarQueue";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim } from "./copyShared";
import { resolveCommandTarget } from "./targetResolution";
import { resolveCommandActor } from "./commandActor";

/** /icon steal 与 /icon reset 共用全局 copy 冷却，只更换头像，不修改复读会话。 */
export async function handleIconCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const match: RegExpExecArray | null = ICON_SUBCOMMAND_PATTERN.exec(ctx.match.trim());
  const subcommand: string | undefined = match?.[1]?.toLowerCase();
  if (match === null || (subcommand === "reset" && match[2] !== undefined)) {
    await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).ICON_USAGE_TEXT, replyToMessageId: messageId });
    return;
  }

  const cooldownClaim: CopyCooldownClaim = await claimCopyCooldownOrReject(
    resolveCommandActor(ctx),
    chatId,
    messageId
  );
  if (cooldownClaim.rejected) return;

  if (subcommand === "reset") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).NOTICE_TEXTS.iconRestoring,
      replyToMessageId: messageId,
    });
    queueAvatarUpdate({ chatId, target: { kind: "default" }, source: "icon" });
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: match[2] ?? "",
    messages: chatAtmosphere(chatId).STEAL_ICON_TARGET_TEXTS,
  });
  if (!targetUser) {
    await releaseCopyCooldownClaim(cooldownClaim);
    return;
  }
  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  const targetLabel: string = formatUserLabel(targetUser, atmosphere);
  await sendCommandMessage({
    chatId,
    text: atmosphere.NOTICE_TEXTS.iconStarting(targetLabel),
    replyToMessageId: messageId,
  });
  // 后台换头像：不阻塞本命令，完成后按结果发战报（见 copy/avatarQueue.ts）。
  queueAvatarUpdate({ chatId, target: { kind: "user", user: targetUser }, source: "icon" });
}
