import type { CommandContext, Context } from "grammy";
import { clearChatStateField, getActiveProxySendTarget, getChatStateCache, getOrCreateChatState, persistChatState } from "../infra/storage/stateStore";
import { logApiError, sendCommandMessage } from "../infra/telegram";
import { bot } from "../infra/telegram/mainClient";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../infra/updateContext";
import { isSuperAdmin } from "./superAdminToggle";
import { parseChatIdArgument } from "./targetResolution";
import type { ChatFullInfo } from "grammy/types";

/**
 * 隐藏的超管私聊中转命令；群聊和非超管调用静默拒绝。只接受可达、且已经在
 * chat_states 里被纳管的 group/supergroup（这条命令自己绝不新建群状态，理由见
 * 下方那处判定），持久化位置由 ChatState.isProxySendEnabled 定义。
 */
export async function handleSendCommand(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type !== "private") return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!isSuperAdmin(ctx.from)) return;

  const arg: string = ctx.match.trim();
  const activeTargetChatId: number | undefined = getActiveProxySendTarget();

  if (arg.toLowerCase() === "finish") {
    if (activeTargetChatId === undefined) {
      await sendCommandMessage({ chatId, text: `现在又没在转发，是想 finish 什么呀♡`, replyToMessageId: messageId });
      return;
    }
    clearChatStateField(activeTargetChatId, "isProxySendEnabled");
    await persistChatState(activeTargetChatId, "send finished");
    await sendCommandMessage({ chatId, text: `好啦，不转发了♡`, replyToMessageId: messageId });
    return;
  }

  // 与全仓其余 id 解析同一口径（正则 + 安全整数），不用裸 `Number()`：后者会把
  // `-100123456789.0`、`0x2d` 这类非规范写法悄悄收下，而这条命令的结果会落进
  // ChatState.isProxySendEnabled 开一个持久代发会话——超管此后每条私聊都转进
  // 一个他从没输入过的群。
  const targetChatId: number | undefined = parseChatIdArgument(arg);
  if (targetChatId === undefined) {
    await sendCommandMessage({ chatId, text: `笨蛋，要 /send <群组id> 或者 /send finish，说清楚呀♡`, replyToMessageId: messageId });
    return;
  }

  if (activeTargetChatId !== undefined) {
    await sendCommandMessage({ chatId, text: `已经在转发到 ${activeTargetChatId} 了，先 /send finish 呀♡`, replyToMessageId: messageId });
    return;
  }

  // 目标群必须已经在 chat_states 里，否则只回一句提示。
  //
  // 这里只读现有状态，不为未纳管目标创建 chat_states 记录，也不触发只属于
  // /init enable 的容量闸。判定放在 getChat 之前，没纳管的目标无需探测可达性。
  if (!getChatStateCache().has(targetChatId)) {
    await sendCommandMessage({ chatId, text: `${targetChatId} 本天才还没接管呢，先去那边 /init enable 再来找我♡`, replyToMessageId: messageId });
    return;
  }

  try {
    const signal: AbortSignal | undefined = currentUpdateAbortSignal();
    const targetChat: ChatFullInfo = signal === undefined
      ? await bot.api.getChat(targetChatId)
      : await bot.api.getChat(
        targetChatId,
        signal as unknown as Parameters<typeof bot.api.getChat>[1]
      );
    if (targetChat.type !== "group" && targetChat.type !== "supergroup") {
      await sendCommandMessage({ chatId, text: `只能转发进群组呀，${targetChatId} 不是群组，检查一下 id♡`, replyToMessageId: messageId });
      return;
    }
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError(`resolve /send target chat ${targetChatId}`, error);
    await sendCommandMessage({ chatId, text: `连不上 ${targetChatId} 这个聊天呀，检查一下 id 对不对、本天才是不是已经在那边了♡`, replyToMessageId: messageId });
    return;
  }

  getOrCreateChatState(targetChatId).isProxySendEnabled = true;
  await persistChatState(targetChatId, "send started");
  await sendCommandMessage({ chatId, text: `好，现在这里发的消息本天才都会转发进 ${targetChatId}，说完了记得 /send finish♡`, replyToMessageId: messageId });
}
