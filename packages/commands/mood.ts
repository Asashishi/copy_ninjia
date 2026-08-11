import type { CommandContext, Context } from "grammy";
import { queryAiMood, switchAiMood } from "../aiChat";
import { aiChatConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { refuseIfConfigBroken } from "./configGate";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import type { CachedUser } from "../types/chatState";

interface MoodAvailabilityOptions {
  chatId: number;
  messageId?: number;
  feature: "AI mood query" | "AI mood switch";
  brokenConfigText: (file: string) => string;
  disabledText: string;
}

/** 心情查询与重抽共用的运行前提；只负责说明 Worker 为何不可用，不做权限判断。 */
async function isMoodAvailable({
  chatId,
  messageId,
  feature,
  brokenConfigText,
  disabledText,
}: MoodAvailabilityOptions): Promise<boolean> {
  // 前提不齐时 AI Worker 根本没启动，post 只会同步失败并把 Worker 标成不可用；
  // 先点名配置文件，别让运维在「Worker 没回话」的兜底文案里猜原因。
  const refused: boolean = await refuseIfConfigBroken({
    readiness: aiChatConfigReadiness(),
    chatId,
    messageId,
    feature,
    text: brokenConfigText,
  });
  if (refused) return false;

  if (getChatState(chatId).isAIChatEnabled !== true) {
    await sendCommandMessage({
      chatId,
      text: disabledText,
      replyToMessageId: messageId,
    });
    return false;
  }
  return true;
}

/**
 * 处理 /query_mood 指令：任意群成员均可查询本群 AI 当前有效心情。主线程
 * 只向 AI Worker 投递 queryMood 并等待 moodQueried 回执；不经过权限系统，
 * 也不强制重抽尚未自然到期的心情。
 */
export async function handleQueryMoodCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const available: boolean = await isMoodAvailable({
    chatId,
    messageId,
    feature: "AI mood query",
    brokenConfigText: (file: string): string => `本天才的 ${file} 写坏了，连心情表都读不出来还查什么？修好再重启，笨蛋♡`,
    disabledText: `本群连 AI 闲聊都没开，本天才在这儿根本没有心情可查呀，笨蛋♡`,
  });
  if (!available) return;

  let moodName: string;
  try {
    moodName = await queryAiMood(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to confirm AI mood query for chat ${chatId}:`, error);
    await sendCommandMessage({
      chatId,
      text: `呜……本天才的 AI 脑袋没及时回话，这次没查到当前心情，过会儿再试吧♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  await sendCommandMessage({
    chatId,
    text: `本天才现在的心情是「${moodName}」♡`,
    replyToMessageId: messageId,
  });
}

/**
 * 处理 /switch_mood 指令：立即重抽本群 AI 的当前心情并回复结果。心情缓存
 * 在 AI Worker 线程内（cache/workers/aiChat/mood.ts），主线程只 post 一条 switchMood
 * 请求、等 moodSwitched 回执单独带回新心情名（见 aiChat/index.ts 的 switchAiMood），
 * 回复固定从这里发出，不走 AI 回复流水线。仅持有 isCanSwitchMood 的身份可用；
 * 超级管理员恒持有该权限（见 whitelist.ts），白名单身份可由 /permission 单独获权；其他人尝试只会被嘲讽。
 */
export async function handleSwitchMoodCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (!actor || !hasCommandPermission(ctx, "isCanSwitchMood")) {
    await sendCommandMessage({
      chatId,
      text: `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想给本天才换心情？本天才的心情才轮不到杂鱼做主呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const available: boolean = await isMoodAvailable({
    chatId,
    messageId,
    feature: "AI mood switch",
    brokenConfigText: (file: string): string => `本天才的 ${file} 写坏了，连心情表都读不出来还换什么？修好再重启，笨蛋♡`,
    disabledText: `本群连 AI 闲聊都没开，本天才在这儿根本没有心情可换呀，笨蛋♡`,
  });
  if (!available) return;

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
