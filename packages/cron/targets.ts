/**
 * `chat_id: ["all"]` 与 `["except", ...]` 的投递目标：所有已 `/init enable`、未被排除、
 * 且机器人此刻能发出本任务全部动作的群。每一轮开始时逐群现查，不发送任何消息（发送只在
 * cron/delivery.ts）。
 *
 * 权限按 Bot API 的成员身份判定：群主与管理员可发（频道管理员要有 can_post_messages）；
 * 被限制的机器人按自身的 can_send_*；普通成员再读群的默认成员权限；已离开或被踢出不可发。
 * 文字要 can_send_messages，图片要 can_send_photos，文件要 can_send_documents，语音要
 * can_send_voice_notes；缺任何一项整群跳过，不让一个群只收到半套动作。查询失败的群本轮
 * 同样跳过（错误由统一的 Telegram 动作边界记日志）。
 */

import type { ChatFullInfo, ChatMember, ChatPermissions } from "grammy/types";
import { getChatStateCache } from "../infra/storage/stateStore";
import { logUnlessAborted, runTelegramAction } from "../infra/telegram/actions/core";
import { bot } from "../infra/telegram/mainClient";
import { signalArgs } from "../libs/telegramSignalArgs";
import type { CronAction, CronGroupTargets, CronSendNeeds, CronTaskSchedule } from "../types/cron";

/** 汇总任务动作需要的发送权限。 */
export function sendNeedsOf(actions: readonly Readonly<CronAction>[]): CronSendNeeds {
  let text: boolean = false;
  let photos: boolean = false;
  let documents: boolean = false;
  let voiceNotes: boolean = false;
  for (const action of actions) {
    switch (action.type) {
      case "send_message":
        text = true;
        break;
      case "send_image":
        photos = true;
        break;
      case "send_file":
        documents = true;
        break;
      case "send_voice":
        voiceNotes = true;
        break;
    }
  }
  return { text, photos, documents, voiceNotes };
}

/** 一组 can_send_* 是否覆盖本任务需要的全部发送权限；缺省的位按没有处理。 */
function coversNeeds(permissions: Readonly<ChatPermissions>, needs: CronSendNeeds): boolean {
  return (!needs.text || permissions.can_send_messages === true) &&
    (!needs.photos || permissions.can_send_photos === true) &&
    (!needs.documents || permissions.can_send_documents === true) &&
    (!needs.voiceNotes || permissions.can_send_voice_notes === true);
}

/**
 * 机器人的成员身份能否直接判定可发；普通成员返回 undefined，需要再读群的默认权限。
 * 纯函数，导出供测试逐状态核对。
 */
export function memberCanSend(member: ChatMember, needs: CronSendNeeds): boolean | undefined {
  switch (member.status) {
    case "creator":
      return true;
    case "administrator":
      // 只有频道的管理员身份带 can_post_messages；群里的管理员缺省即可发言。
      return member.can_post_messages !== false;
    case "restricted":
      return member.is_member && coversNeeds(member, needs);
    case "member":
      return undefined;
    case "left":
    case "kicked":
      return false;
  }
}

/** 机器人在一个群里能否发出本任务的全部动作；查询失败返回 false。 */
async function canSendIn(chatId: number, needs: CronSendNeeds, signal: AbortSignal): Promise<boolean> {
  const member: ChatMember | undefined = await runTelegramAction({
    action: `read the bot's membership for cron in chat ${chatId}`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      bot.api.getChatMember(chatId, bot.botInfo.id, ...signalArgs(requestSignal)),
    map: (value: ChatMember): ChatMember => value,
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
  if (member === undefined) return false;
  const direct: boolean | undefined = memberCanSend(member, needs);
  if (direct !== undefined) return direct;
  const defaults: ChatPermissions | undefined = await runTelegramAction({
    action: `read the default member permissions for cron in chat ${chatId}`,
    execute: (requestSignal?: AbortSignal): Promise<ChatFullInfo> =>
      bot.api.getChat(chatId, ...signalArgs(requestSignal)),
    map: (chat: ChatFullInfo): ChatPermissions | undefined => chat.permissions,
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
  return defaults !== undefined && coversNeeds(defaults, needs);
}

/**
 * 解析本轮的投递目标：已启用、且不在 `excluded` 里的群按 chat id 升序逐个现查。任务被
 * 热重载撤销或本轮被取消时停在当前群，不再查询后面的群；已查完的部分照常返回，由调用方
 * 按同一判据收场。
 *
 * @param excluded `chat_id: ["except", ...]` 列出的会话；这些群不查询也不计入 skipped。
 *   逐个列出会话的任务不经过本模块，由 cron/run.ts 直接投递。
 */
export async function resolveCronGroupTargets(
  schedule: CronTaskSchedule,
  excluded: readonly number[],
  signal: AbortSignal
): Promise<CronGroupTargets> {
  const candidates: number[] = [];
  for (const [chatId, state] of getChatStateCache()) {
    if (state.isInitEnabled === true && !excluded.includes(chatId)) candidates.push(chatId);
  }
  candidates.sort((left: number, right: number): number => left - right);
  const needs: CronSendNeeds = sendNeedsOf(schedule.task.actions);
  const chatIds: number[] = [];
  let skipped: number = 0;
  for (const chatId of candidates) {
    if (schedule.cancelled || signal.aborted) break;
    if (await canSendIn(chatId, needs, signal)) chatIds.push(chatId);
    else skipped++;
  }
  return { chatIds, skipped };
}
