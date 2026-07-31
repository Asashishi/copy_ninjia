import type { CommandContext, Context } from "grammy";
import { switchAiMood } from "../aiChat";
import { aiChatConfigReadiness } from "../config/readiness";
import { AI_CHAT_GEMINI_API_KEY } from "../infra/config";
import { getChatState } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { refuseIfConfigBroken } from "./configGate";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import type { CachedUser } from "../types/chatState";

/**
 * 处理 /switch_mood 指令：立即重抽本群 AI 的当前心情并回复结果。心情缓存
 * 在 AI Worker 线程内（cache/workers/aiChat/mood.ts），主线程只 post 一条 switchMood
 * 请求、等 moodSwitched 回执单独带回新心情名（见 aiChat/index.ts 的 switchAiMood），
 * 回复固定从这里发出，不走 AI 回复流水线。超级管理员恒可用，白名单身份可通过
 * isCanSwitchMood 单独获权；其他人尝试只会被嘲讽。
 */
export async function handleSwitchMoodCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (!actor || !hasCommandPermission(ctx, "isCanSwitchMood", true)) {
    await sendCommandMessage({
      chatId,
      text: `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想给本天才换心情？本天才的心情才轮不到杂鱼做主呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // 前提不齐时 AI Worker 根本没启动，post 只会同步失败并把 Worker 标成不可用；
  // 先点名到底缺什么，别让运维在「Worker 没回话」的兜底文案里猜原因。两道前提
  // 分开报，理由同 /ai_chat：一个要改 .env，一个要改配置文件。
  if (AI_CHAT_GEMINI_API_KEY === undefined) {
    await sendCommandMessage({
      chatId,
      text: `本天才没有 Gemini 的 key，哪来的心情给你换呀？去 .env 里补上 AI_CHAT_GEMINI_API_KEY 再重启，笨蛋♡`,
      replyToMessageId: messageId,
    });
    return;
  }
  const refused: boolean = await refuseIfConfigBroken({
    readiness: aiChatConfigReadiness(),
    chatId,
    messageId,
    feature: "AI mood switch",
    text: (file: string): string => `本天才的 ${file} 写坏了，连心情表都读不出来还换什么？修好再重启，笨蛋♡`,
  });
  if (refused) return;

  if (getChatState(chatId).isAIChatEnabled !== true) {
    await sendCommandMessage({
      chatId,
      text: `本群连 AI 闲聊都没开，本天才在这儿根本没有心情可换呀，笨蛋♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  let moodName: string;
  try {
    moodName = await switchAiMood(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to confirm AI mood switch for chat ${chatId}:`, error);
    await sendCommandMessage({
      chatId,
      text: `呜……本天才的 AI 脑袋没及时回话，这次没确认到新心情，过会儿再试吧♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // Worker 已明确回执成功后，Telegram 发送失败属于消息投递错误，不能再
  // 伪装成重抽失败；让 grammY 的统一错误边界按 update 失败处理。
  await sendCommandMessage({
    chatId,
    text: `哼，那就依你重抽一次——本天才现在的心情是「${moodName}」♡`,
    replyToMessageId: messageId,
  });
}
