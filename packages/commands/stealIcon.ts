import type { CommandContext, Context } from "grammy";
import { STEAL_ICON_TARGET_TEXTS } from "../consts/commands";
import type { CachedUser } from "../types/chatState";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, stealAvatarInBackground } from "./copyShared";
import type { CopyCooldownClaim } from "../types/copy/cooldown";
import { resolveCommandActor } from "./commandActor";

/**
 * 处理 /steal_icon 指令：只把目标的头像偷来戴上，不开启复读。目标的指定方式
 * 与 /copy 一致（回复消息优先，其次 @username 参数），也共用 copy 类命令的
 * 全局冷却时钟（跨所有群）——消耗的是同一个"换头像"限流资源，不共用的话
 * 冷却就形同虚设。不触碰复读状态：正在复读谁、用什么模式都保持原样，偷头像
 * 只是顺手换张脸。
 */
export async function handleStealIconCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const cooldownClaim: CopyCooldownClaim = await claimCopyCooldownOrReject(
    resolveCommandActor(ctx),
    chatId,
    messageId
  );
  if (cooldownClaim.rejected) return;

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, STEAL_ICON_TARGET_TEXTS);
  if (!targetUser) {
    await releaseCopyCooldownClaim(cooldownClaim);
    return;
  }

  // 全局冷却时钟已经在 claimCopyCooldownOrReject 里原子占用并落盘（见其
  // persistGlobalState 调用），这里不需要再落一次。

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
