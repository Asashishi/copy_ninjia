import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types";
import { getChatState, getOrCreateChatState, saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { QUIET_DEFAULT_MINUTES, QUIET_MAX_MINUTES, QUIET_MIN_MINUTES } from "../consts/commands";

/**
 * 处理 /quiet 指令：让机器人在本群安静一段时间——期间不触发 AI 随机插话、
 * 洗澡「看看」和随机复读这些主动刷存在感的行为；回复机器人 / @ 机器人的
 * AI 必回、各类指令、以及 /copy 锁定目标的复读均不受影响（对话缓存也照常
 * 攒，静默结束后 AI 不缺上下文）。时长参数为分钟数，缺省 3 分钟，超出
 * 1~15 的范围会被收敛到边界；静默期内不允许重复使用（不能续时/重新计时），
 * 想提前解除或重设时长要先 /unquiet。
 */
export async function handleQuietCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const quietUntil: number = getChatState(chatId).quietUntil ?? 0;
  if (quietUntil > Date.now()) {
    const remainingMinutes: number = Math.ceil((quietUntil - Date.now()) / 60_000);
    await sendMessage(chatId, `本天才已经在闭嘴了呀（还剩约 ${remainingMinutes} 分钟），一个静默没结束不许再叠，想重来就先 /unquiet，笨蛋♡`, messageId);
    return;
  }

  const arg: string = ctx.match.trim();
  let minutes: number = QUIET_DEFAULT_MINUTES;
  if (arg) {
    const parsed: number = Number(arg);
    if (!Number.isFinite(parsed)) {
      await sendMessage(chatId, `笨蛋，/quiet 后面要接分钟数（${QUIET_MIN_MINUTES}~${QUIET_MAX_MINUTES}），不填就是 ${QUIET_DEFAULT_MINUTES} 分钟♡`, messageId);
      return;
    }
    minutes = Math.min(QUIET_MAX_MINUTES, Math.max(QUIET_MIN_MINUTES, Math.round(parsed)));
  }

  const state: ChatState = getOrCreateChatState(chatId);
  state.quietUntil = Date.now() + minutes * 60_000;
  await saveState();

  await sendMessage(chatId, `哼，本天才就赏你们 ${minutes} 分钟清净，不主动插话也不复读。想本天才了就回复或 @ 我，杂鱼♡`, messageId);
}

/**
 * 处理 /unquiet 指令：提前解除 /quiet 静默。本群没在静默中时只嘲讽一句，
 * 不改任何状态。
 */
export async function handleUnquietCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const state: ChatState = getChatState(chatId);
  if ((state.quietUntil ?? 0) <= Date.now()) {
    await sendMessage(chatId, `本天才本来就没在闭嘴呀，笨蛋要 /unquiet 什么呢♡`, messageId);
    return;
  }

  // 静默生效中说明 /quiet 写过状态，getChatState 拿到的一定是 Map 里的真实
  // 条目（不是共享的冻结默认值），直接改它即可。
  state.quietUntil = undefined;
  await saveState();

  await sendMessage(chatId, `哼，这么快就受不了没有本天才的日子啦？静默解除，杂鱼们做好被吵的准备吧♡`, messageId);
}
