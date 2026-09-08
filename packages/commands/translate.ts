import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState } from "../types/chatState";
import type { TranslateState } from "../types/translate";
import { translateStates } from "../cache/main/translateState";
import { translateConfigReadiness } from "../config/readiness";
import {
  TRANSLATE_ARGUMENT_PATTERN,
  TRANSLATE_CAPACITY_TEXT,
  TRANSLATE_CHAT_CAPACITY_TEXT,
  TRANSLATE_STOP_ARGUMENT_PATTERN,
  TRANSLATE_LANGUAGE_LABELS,
  TRANSLATE_LIST_JSON_INDENT,
  TRANSLATE_LIST_JSON_LANGUAGE,
  TRANSLATE_TARGET_TEXTS,
  TRANSLATE_TOGGLE_TEXTS,
  TRANSLATE_USAGE_TEXT,
} from "../consts/translate";
import { getChatState, persistGlobalState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { isTelegramGroupChatId } from "../libs/telegramId";
import { getTranslateState, setTranslateState, stopTranslation } from "../translate/state";
import { formatUserLabel } from "../users/userLabel";
import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";
import { resolveCommandTarget } from "./targetResolution";

/** 翻译功能的配置前提；只发送统一的短期命令提示。 */
function refuseUnavailableTranslation(chatId: number, messageId: number | undefined): Promise<boolean> {
  return refuseIfConfigBroken({
    readiness: translateConfigReadiness(),
    chatId,
    messageId,
    feature: "Translation",
    text: (file: string): string => `本天才的 ${file} 不见了或写坏了，翻不了呀。补好再重启，笨蛋♡`,
  });
}

/**
 * 独立翻译命令：方向加回复目标或 @username 开始，stop 停止本群全部或指定目标，
 * list 用 JSON 代码块列出方向，enable/disable 使用既有翻译权限。
 * 会话变更等主、备落盘后才反馈成功。
 */
export async function handleTranslateCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const argument: string = ctx.match.trim();
  if (!isTelegramGroupChatId(chatId)) return;

  if (argument === "list") {
    const text: string = JSON.stringify(TRANSLATE_LANGUAGE_LABELS, null, TRANSLATE_LIST_JSON_INDENT);
    await sendCommandMessage({
      chatId,
      text,
      entities: [{ type: "pre", offset: 0, length: text.length, language: TRANSLATE_LIST_JSON_LANGUAGE }],
      replyToMessageId: messageId,
    });
    return;
  }

  if (argument === "enable" || argument === "disable") {
    await runChatToggleCommand({
      ctx,
      texts: TRANSLATE_TOGGLE_TEXTS,
      permission: "isCanControllTranslatePermission",
      persistReason: "translation toggled",
      runtimeLabel: "translation runtime",
      read: (state: ChatState): boolean => state.isTranslationEnabled === true,
      write: (state: ChatState, enabled: boolean): void => { state.isTranslationEnabled = enabled; },
      refuseEnable: refuseUnavailableTranslation,
      beforeDisable: (chatId: number): Promise<void> => stopTranslation(chatId),
    });
    return;
  }

  const stopMatch: RegExpExecArray | null = TRANSLATE_STOP_ARGUMENT_PATTERN.exec(argument);
  if (stopMatch !== null) {
    if (stopMatch[1] === undefined && ctx.msg.reply_to_message === undefined && ctx.msg.external_reply === undefined) {
      await stopTranslation(chatId);
      await sendCommandMessage({ chatId, text: "本群所有杂鱼的翻译都停止啦，需要时再来求本天才♡", replyToMessageId: messageId });
      return;
    }
    const target: CachedUser | undefined = await resolveCommandTarget({
      chatId, message: ctx.msg, botUserId: ctx.me.id, rawArgument: stopMatch[1] ?? "",
      messages: TRANSLATE_TARGET_TEXTS, acceptUserId: true, acceptChatId: true,
    });
    if (target === undefined) return;
    const current: TranslateState | undefined = getTranslateState(chatId, target.id);
    await stopTranslation(chatId, target.id);
    await sendCommandMessage({
      chatId,
      text: current === undefined
        ? `${formatUserLabel(target)} 本来就没在用翻译呀，笨蛋♡`
        : `本天才已经停止给 ${formatUserLabel(target)} 翻译啦，其他杂鱼照常哦♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const match: RegExpExecArray | null = TRANSLATE_ARGUMENT_PATTERN.exec(argument);
  const language: string | undefined = match?.[1];
  if (language !== "ja" && language !== "cn" && language !== "en" && language !== "uk" && language !== "ru") {
    await sendCommandMessage({ chatId, text: TRANSLATE_USAGE_TEXT, replyToMessageId: messageId });
    return;
  }
  if (await refuseUnavailableTranslation(chatId, messageId)) return;
  if (getChatState(chatId).isTranslationEnabled !== true) {
    await sendCommandMessage({
      chatId,
      text: "本群翻译功能还没开启，找有翻译管理权限的人 /translate enable 一下吧♡",
      replyToMessageId: messageId,
    });
    return;
  }

  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: match?.[2] ?? "",
    messages: TRANSLATE_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const current: TranslateState | undefined = getTranslateState(chatId, target.id);
  if (current !== undefined) {
    await sendCommandMessage({
      chatId,
      text: `本天才正在把 ${formatUserLabel(current.translatedUser)} 的文字翻成${TRANSLATE_LANGUAGE_LABELS[current.language]}，要换方向先回复 TA 用 /translate stop，笨蛋♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  if (!setTranslateState(chatId, { translatedUser: target, language })) {
    await sendCommandMessage({
      chatId,
      text: translateStates.has(chatId) ? TRANSLATE_CHAT_CAPACITY_TEXT : TRANSLATE_CAPACITY_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }
  await persistGlobalState("translation started");
  await sendCommandMessage({
    chatId,
    text: `本天才开始把 ${formatUserLabel(target)} 的文字翻成${TRANSLATE_LANGUAGE_LABELS[language]}啦，停止用 /translate stop♡`,
    replyToMessageId: messageId,
  });
}
