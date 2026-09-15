import { syncAiChatPersona } from "../aiChat/workerBridge";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { PROMPT_COMMAND_PATTERN, PROMPT_COMMAND_TEXTS } from "../consts/prompt";
import { getChatState, getOrCreateChatState, persistChatState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { forumTopicThreadId } from "../libs/forumTopic";
import { hasCommandPermission } from "./commandActor";

/** 按身份授权配置群级人设；成功回执必须晚于 SQLite 精确 revision ACK。 */
export async function handlePromptCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  let text: string;
  if (getChatState(chatId).isInitEnabled !== true) {
    text = PROMPT_COMMAND_TEXTS.notInitialized;
  } else if (!hasCommandPermission(ctx, "isCanConfigAiPrompt")) {
    text = PROMPT_COMMAND_TEXTS.rejected;
  } else {
    const match: RegExpExecArray | null = PROMPT_COMMAND_PATTERN.exec(ctx.match.trim());
    const persona: string | undefined = match?.[2]?.trim();
    const remove: boolean = match?.[3] !== undefined;
    if (!remove && !persona) {
      text = PROMPT_COMMAND_TEXTS.usage;
    } else {
      const state: ChatState = getOrCreateChatState(chatId);
      state.aiPersona = remove ? undefined : persona;
      await persistChatState(chatId, "AI persona configured");
      syncAiChatPersona(chatId);
      text = remove ? PROMPT_COMMAND_TEXTS.removed : PROMPT_COMMAND_TEXTS.configured;
    }
  }
  await sendCommandMessage({ chatId, text, replyToMessageId: ctx.msgId, messageThreadId: forumTopicThreadId(ctx.msg) });
}
