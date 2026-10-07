import { botMessageActivity } from "../cache/main/botMessage";
import {
  BOT_MESSAGE_ACTIVITY_LIMIT,
  BOT_MESSAGE_ACTIVITY_MAX_ENTRIES,
  BOT_MESSAGE_ACTIVITY_TTL_MS,
} from "../consts/botMessage";
import type { BotMessageActivity } from "../types/botMessage";
import type { Message, User } from "grammy/types";

/** 为一条机器人发言记录设置或续期独立的过期计时器（BOT_MESSAGE_ACTIVITY_TTL_MS）。 */
function refreshActivity(botId: number, activity: BotMessageActivity, now: number): void {
  activity.expiresAt = now + BOT_MESSAGE_ACTIVITY_TTL_MS;
  if (activity.timer === null) {
    activity.timer = setTimeout((): void => {
      if (botMessageActivity.get(botId) === activity) botMessageActivity.delete(botId);
    }, BOT_MESSAGE_ACTIVITY_TTL_MS).unref();
  } else {
    activity.timer.refresh();
  }
}

/**
 * 主线程在分发前计数真实机器人发来的 message；前 BOT_MESSAGE_ACTIVITY_LIMIT 条放行，之后静默丢弃。
 * 计数按 bot id 跨群共享，收到发言后把过期时间续到 BOT_MESSAGE_ACTIVITY_TTL_MS 之后。容量满时拒绝
 * 尚未记录的机器人，不为它分配计时器。频道身份、自身回投与非 message 更新不计入。
 */
export function shouldPassBotMessage(message: Message | undefined, ownBotId: number): boolean {
  const sender: User | undefined = message?.from;
  if (sender === undefined || !sender.is_bot || message?.sender_chat !== undefined) {
    return true;
  }
  if (sender.id === ownBotId) return true;
  const now: number = Date.now();
  let activity: BotMessageActivity | undefined = botMessageActivity.get(sender.id);
  if (activity !== undefined && now >= activity.expiresAt) {
    if (activity.timer !== null) clearTimeout(activity.timer);
    botMessageActivity.delete(sender.id);
    activity = undefined;
  }
  if (activity === undefined) {
    if (botMessageActivity.size >= BOT_MESSAGE_ACTIVITY_MAX_ENTRIES) return false;
    activity = { count: 1, expiresAt: now, timer: null };
    refreshActivity(sender.id, activity, now);
    botMessageActivity.set(sender.id, activity);
    return true;
  }
  if (activity.count <= BOT_MESSAGE_ACTIVITY_LIMIT) activity.count += 1;
  refreshActivity(sender.id, activity, now);
  return activity.count <= BOT_MESSAGE_ACTIVITY_LIMIT;
}
