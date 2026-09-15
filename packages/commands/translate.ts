import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState } from "../types/chatState";
import type { TranslateState } from "../types/translate";
import { translateStates } from "../cache/main/translateState";
import { translateConfigReadiness } from "../config/readiness";
import { TRANSLATE_ARGUMENT_PATTERN, TRANSLATE_STOP_ARGUMENT_PATTERN, TRANSLATE_LANGUAGE_LABELS, TRANSLATE_LIST_JSON_INDENT, TRANSLATE_LIST_JSON_LANGUAGE } from "../consts/translate";

import { getChatState, persistGlobalState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { explicitReplyTo } from "../libs/forumTopic";
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
    text: (file: string): string => chatAtmosphere(chatId).NOTICE_TEXTS.translateConfigInvalid(file),
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
      texts: chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_TOGGLE_TEXTS,
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
    if (stopMatch[1] === undefined && explicitReplyTo(ctx.msg) === undefined && ctx.msg.external_reply === undefined) {
      await stopTranslation(chatId);
      await sendCommandMessage({ chatId, text: chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_STOP_ALL_TEXT, replyToMessageId: messageId });
      return;
    }
    const target: CachedUser | undefined = await resolveCommandTarget({
      chatId, message: ctx.msg, botUserId: ctx.me.id, rawArgument: stopMatch[1] ?? "",
      messages: chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_TARGET_TEXTS, acceptUserId: true, acceptChatId: true,
    });
    if (target === undefined) return;
    const current: TranslateState | undefined = getTranslateState(chatId, target.id);
    await stopTranslation(chatId, target.id);
    await sendCommandMessage({
      chatId,
      text: current === undefined
        ? chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.translateNotRunning(formatUserLabel(target, chatAtmosphere(ctx.chat?.id ?? 0)))
        : chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.translateStopped(formatUserLabel(target, chatAtmosphere(ctx.chat?.id ?? 0))),
      replyToMessageId: messageId,
    });
    return;
  }

  const match: RegExpExecArray | null = TRANSLATE_ARGUMENT_PATTERN.exec(argument);
  const language: string | undefined = match?.[1];
  if (language !== "ja" && language !== "cn" && language !== "en" && language !== "uk" && language !== "ru") {
    await sendCommandMessage({ chatId, text: chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_USAGE_TEXT, replyToMessageId: messageId });
    return;
  }
  if (await refuseUnavailableTranslation(chatId, messageId)) return;
  if (getChatState(chatId).isTranslationEnabled !== true) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_DISABLED_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: match?.[2] ?? "",
    messages: chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const current: TranslateState | undefined = getTranslateState(chatId, target.id);
  if (current !== undefined) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.translateAlreadyRunning(formatUserLabel(current.translatedUser, chatAtmosphere(ctx.chat?.id ?? 0)), TRANSLATE_LANGUAGE_LABELS[current.language]),
      replyToMessageId: messageId,
    });
    return;
  }

  if (!setTranslateState(chatId, { translatedUser: target, language })) {
    await sendCommandMessage({
      chatId,
      text: translateStates.has(chatId) ? chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_CHAT_CAPACITY_TEXT : chatAtmosphere(ctx.chat?.id ?? 0).TRANSLATE_CAPACITY_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }
  await persistGlobalState("translation started");
  await sendCommandMessage({
    chatId,
    text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.translateStarted(formatUserLabel(target, chatAtmosphere(ctx.chat?.id ?? 0)), TRANSLATE_LANGUAGE_LABELS[language]),
    replyToMessageId: messageId,
  });
}
