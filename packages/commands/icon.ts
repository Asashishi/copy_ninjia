import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";

import { ICON_SUBCOMMAND_PATTERN } from "../consts/icon";
import type { CachedUser } from "../types/chatState";
import type { CopyCooldownClaim } from "../types/copy/cooldown";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, restoreAvatarInBackground, stealAvatarInBackground } from "./copyShared";
import { resolveCommandActor } from "./commandActor";

/** /icon steal 与 /icon reset 共用全局 copy 冷却，只更换头像，不修改复读会话。 */
export async function handleIconCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const match: RegExpExecArray | null = ICON_SUBCOMMAND_PATTERN.exec(ctx.match.trim());
  const subcommand: string | undefined = match?.[1];
  if (match === null || (subcommand === "reset" && match[2] !== undefined)) {
    await sendCommandMessage({ chatId, text: chatAtmosphere(ctx.chat?.id ?? 0).ICON_USAGE_TEXT, replyToMessageId: messageId });
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
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.iconRestoring,
      replyToMessageId: messageId,
    });
    restoreAvatarInBackground({
      chatId,
      successText: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.iconRestored,
      failureText: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.iconRestoreFailed,
    });
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, chatAtmosphere(ctx.chat?.id ?? 0).STEAL_ICON_TARGET_TEXTS, match[2] ?? "");
  if (!targetUser) {
    await releaseCopyCooldownClaim(cooldownClaim);
    return;
  }
  const targetLabel: string = formatUserLabel(targetUser, chatAtmosphere(ctx.chat?.id ?? 0));
  await sendCommandMessage({
    chatId,
    text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.iconStarting(targetLabel),
    replyToMessageId: messageId,
  });
  stealAvatarInBackground({
    chatId,
    target: targetUser,
    successText: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.iconChanged(targetLabel),
    failureText: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.iconFailed(targetLabel),
  });
}
