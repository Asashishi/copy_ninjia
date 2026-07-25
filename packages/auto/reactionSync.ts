import type { Context } from "grammy";
import type { CopyableReaction } from "../types/reactionQueue";
import { getActiveCopyIn } from "../infra/storage/stateStore";
import { enqueueReaction } from "../copy/reactionQueue";
import type { MessageReactionUpdated } from "@grammyjs/types";
import type { CachedUser, CopyMode } from "../types/chatState";

/**
 * 处理 message_reaction 更新：把复制目标的表情回应（普通 emoji 和自定义
 * emoji 都支持）同步到同一条消息上；目标移除了自己的回应时也会跟着清除。
 * 与复读一致，只在发起 /copy 的那个群里同步（判定统一走 getActiveCopyIn）。
 * 实际的 setMessageReaction 调用走 reactionQueue（429 重试、同消息合并、
 * 按 chat 隔离限流等待）；本 update 等到对应版本被应用、覆盖或按硬顶丢弃
 * 才结算，使下一轮取数不会提前确认仍在后台的反应。
 */
export async function handleReaction(ctx: Context): Promise<void> {
  const reaction: MessageReactionUpdated | undefined = ctx.messageReaction;
  if (!reaction) return;

  const activeCopy: { copiedUser: CachedUser; copyMode: CopyMode | undefined; } | null = getActiveCopyIn(reaction.chat.id);
  const reactorId: number | undefined = reaction.actor_chat ? reaction.actor_chat.id : reaction.user?.id;
  if (!activeCopy || reactorId !== activeCopy.copiedUser.id) return;

  // grammY 的 ctx.reactions() 已把 old/new 的差量按类型分组算好（付费反应被
  // 单独归类，天然排除——原因见 CopyableReaction 类型注释）。机器人没有
  // Premium，一条消息只能设 1 个反应；目标（若是 Premium 用户）却可能同时
  // 点了 2~3 个：优先跟随本次新增的那个，没有新增（比如只是取消了其中一个）
  // 就退回仍点着的第一个；全空表示目标清掉了可复制的反应，跟着清除。
  const { emoji, emojiAdded, emojiRemoved, customEmoji, customEmojiAdded, customEmojiRemoved }: ReturnType<typeof ctx.reactions> = ctx.reactions();
  let toApply: CopyableReaction[];
  if (emojiAdded.length > 0) {
    toApply = [{ type: "emoji", emoji: emojiAdded[0]! }];
  } else if (customEmojiAdded.length > 0) {
    toApply = [{ type: "custom_emoji", custom_emoji_id: customEmojiAdded[0]! }];
  } else if (emoji.length > 0) {
    toApply = [{ type: "emoji", emoji: emoji[0]! }];
  } else if (customEmoji.length > 0) {
    toApply = [{ type: "custom_emoji", custom_emoji_id: customEmoji[0]! }];
  } else if (emojiRemoved.length === 0 && customEmojiRemoved.length === 0) {
    // 这次变化不涉及任何可复制的反应（比如目标只点了个付费反应）：机器人
    // 既没有要设的也没有要清的，不值得为此花一次 API 调用。
    return;
  } else {
    toApply = [];
  }

  await enqueueReaction({
    chatId: reaction.chat.id,
    messageId: reaction.message_id,
    reactions: toApply,
    updateId: ctx.update.update_id,
    reactedAtUnix: reaction.date,
  });
}
