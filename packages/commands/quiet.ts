import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { clearChatStateField, getChatState, getOrCreateChatState, persistChatState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { DURATION_UNIT_MS, QUIET_DEFAULT_MINUTES, QUIET_MAX_MINUTES, QUIET_MIN_MINUTES } from "../consts/commands";
import { isQuietUntilActive } from "../libs/chatState";

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
  if (isQuietUntilActive(quietUntil)) {
    const remainingMinutes: number = Math.ceil((quietUntil - Date.now()) / DURATION_UNIT_MS.m);
    await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).NOTICE_TEXTS.quietAlreadyEnabled(remainingMinutes), replyToMessageId: messageId });
    return;
  }

  const arg: string = ctx.match.trim();
  let minutes: number = QUIET_DEFAULT_MINUTES;
  if (arg) {
    const parsed: number = Number(arg);
    if (!Number.isFinite(parsed)) {
      await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).NOTICE_TEXTS.quietUsage(QUIET_MIN_MINUTES, QUIET_MAX_MINUTES, QUIET_DEFAULT_MINUTES), replyToMessageId: messageId });
      return;
    }
    minutes = Math.min(QUIET_MAX_MINUTES, Math.max(QUIET_MIN_MINUTES, Math.round(parsed)));
  }

  const state: ChatState = getOrCreateChatState(chatId);
  state.quietUntil = Date.now() + minutes * DURATION_UNIT_MS.m;
  await persistChatState(chatId, "quiet set");

  await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).NOTICE_TEXTS.quietEnabled(minutes), replyToMessageId: messageId });
}

/**
 * 处理 /unquiet 指令：提前解除 /quiet 静默。本群没在静默中时只嘲讽一句，
 * 不改任何状态。
 */
export async function handleUnquietCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const state: Readonly<ChatState> = getChatState(chatId);
  if (!isQuietUntilActive(state.quietUntil)) {
    await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).NOTICE_TEXTS.quietAlreadyDisabled, replyToMessageId: messageId });
    return;
  }

  // 静默生效中说明 /quiet 写过真实状态；统一清字段，并在它是最后一个字段时
  // 同步回收 Map 条目。
  clearChatStateField(chatId, "quietUntil");
  await persistChatState(chatId, "quiet cleared");

  await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).NOTICE_TEXTS.quietDisabled, replyToMessageId: messageId });
}
