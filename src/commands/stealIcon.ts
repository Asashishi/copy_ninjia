import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState, GlobalCopyState } from "../types";
import { saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, stealAvatarInBackground } from "./copyShared";

/**
 * 处理 /steal_icon 指令：只把目标的头像偷来戴上，不开启复读。目标的指定方式
 * 与 /copy 一致（回复消息优先，其次 @username 参数），也共用 copy 类命令的
 * 全局冷却时钟（跨所有群）——消耗的是同一个"换头像"限流资源，不共用的话
 * 冷却就形同虚设。不触碰复读状态：正在复读谁、用什么模式都保持原样，偷头像
 * 只是顺手换张脸；这里收的 chatStates 纯粹是因为 saveState 要求 chatStates
 * 和 globalCopyState 一起传（同一个 state.json 的完整快照），本身不读不改它。
 */
export async function handleStealIconCommand(
  ctx: CommandContext<Context>,
  users: Record<string, CachedUser>,
  chatStates: Map<number, ChatState>,
  globalCopyState: GlobalCopyState
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const cooldownClaim = await claimCopyCooldownOrReject(globalCopyState, ctx.from, chatId, messageId);
  if (cooldownClaim.rejected) return;

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, users, "/steal_icon");
  if (!targetUser) {
    releaseCopyCooldownClaim(globalCopyState, cooldownClaim);
    return;
  }

  // 全局冷却时钟已经在 claimCopyCooldownOrReject 里原子占用，这里落盘即可。
  await saveState(chatStates, globalCopyState);

  const targetLabel: string = formatUserLabel(targetUser);
  await sendMessage(chatId, `收到收到，本天才这就去把 ${targetLabel} 的脸皮扒下来戴上，杂鱼稍安勿躁~♡`, messageId);

  stealAvatarInBackground(
    chatId,
    targetUser,
    `嘿嘿，${targetLabel} 的脸已经被本天才偷来戴上啦，杂鱼♡`,
    `啧，偷 ${targetLabel} 的头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了），下次再来吧杂鱼♡`
  );
}
