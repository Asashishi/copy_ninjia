import type { CommandContext, Context } from "grammy";
import { STEAL_ICON_TARGET_TEXTS } from "../consts/commands";
import { ICON_USAGE_TEXT } from "../consts/commandUsage";
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
    await sendCommandMessage({ chatId, text: ICON_USAGE_TEXT, replyToMessageId: messageId });
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
      text: `啧，戴腻了别人的脸，本天才这就换回自己的，杂鱼♡`,
      replyToMessageId: messageId,
    });
    restoreAvatarInBackground({
      chatId,
      successText: `呐，本天才的脸回来了，是不是好看多了，杂鱼♡`,
      failureText: `唔，换回自己的脸失败了呢（可能是图取不下来，或者本天才换头像太频繁被限流了），等会儿再试吧杂鱼♡`,
    });
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, STEAL_ICON_TARGET_TEXTS, match[2] ?? "");
  if (!targetUser) {
    await releaseCopyCooldownClaim(cooldownClaim);
    return;
  }
  const targetLabel: string = formatUserLabel(targetUser);
  await sendCommandMessage({
    chatId,
    text: `收到收到，本天才这就去把 ${targetLabel} 的脸皮扒下来戴上，杂鱼稍安勿躁~♡`,
    replyToMessageId: messageId,
  });
  stealAvatarInBackground({
    chatId,
    target: targetUser,
    successText: `嘿嘿，${targetLabel} 的脸已经被本天才偷来戴上啦，杂鱼♡`,
    failureText: `啧，偷 ${targetLabel} 的头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了），下次再来吧杂鱼♡`,
  });
}
