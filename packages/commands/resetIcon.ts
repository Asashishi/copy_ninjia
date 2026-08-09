import type { CommandContext, Context } from "grammy";
import { sendCommandMessage } from "../infra/telegram";
import { claimCopyCooldownOrReject, restoreAvatarInBackground } from "./copyShared";
import type { CopyCooldownClaim } from "../types/copy/cooldown";
import { resolveCommandActor } from "./commandActor";

/**
 * 处理 /reset_icon 指令：把机器人头像复原成默认那张脸（来源见 consts/ui/assets.ts
 * 的 BOT_DEFAULT_AVATAR_URL）。不需要目标参数——复原只有一个终点。
 *
 * 共用 copy 类命令的全局冷却时钟：它换的是同一张脸、消耗的是同一份 Telegram
 * 换头像限流资源，不共用的话 /steal_icon 的冷却可以被「偷一次、复原一次」轮流
 * 绕开。不触碰复读状态：正在复读谁保持原样，这条命令只管脸，与 /steal_icon 对称。
 */
export async function handleResetIconCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const cooldownClaim: CopyCooldownClaim = await claimCopyCooldownOrReject(
    resolveCommandActor(ctx),
    chatId,
    messageId
  );
  if (cooldownClaim.rejected) return;

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
}
