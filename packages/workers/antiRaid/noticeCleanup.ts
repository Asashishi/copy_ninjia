/**
 * 群内公告的延迟自撤（入群守卫线程）。
 *
 * 与 infra/telegram/actions.ts 的 deleteMessageAfter 的区别只有一点：这里的
 * 待删条目登记在册，停机时能被提前兑现。那个裸版本是 `setTimeout(...).unref()`，
 * 定时器活在本 Worker 的 isolate 里——崩溃重建、`stopAntiRaidWorker`、
 * `systemctl restart tg-bot` 都会把它连同待删的公告一起丢掉，公告就此永久
 * 留在群里点着某个成员的名，只能人工删。踢人战报只挂 30 秒，撞上的概率小到
 * 可以接受；刷屏禁言的公告要挂满 FLOOD_MUTE_DURATION_MS（3 分钟），敞口是
 * 前者的六倍，而入群守卫恰恰是有监督重启策略的那条线程。
 *
 * 停机时**立刻删**而不是等：那条公告断言的是「这个人正被按着」，停机之后没人
 * 会再来收拾它；早撤几分钟只是让群里少看几分钟，留着则是永久的公开指名。
 */

import { deleteMessage, deleteMessages } from "../../infra/telegram";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../consts/telegram";
import { pendingNoticeDeletions } from "../../cache/workers/antiRaid/notices";
import { trackAntiRaidTask } from "./taskTracker";
import type { Api } from "grammy";
import type { PendingNoticeDeletion } from "../../types/antiRaid/internal";

export interface ScheduleNoticeDeletionParams {
  chatId: number;
  messageId: number;
  delayMs: number;
  /** 与发这条公告时用的客户端保持一致，删除才走同一条限流队列。 */
  api: Api;
}

/**
 * 挂一条「到点自删」的公告，并登记进停机 flush 的册子。
 *
 * 定时器照旧 `unref()`：这类美化任务不该拦着进程退出，真正的兜底是 flush。
 */
export function scheduleNoticeDeletion({
  chatId,
  messageId,
  delayMs,
  api,
}: ScheduleNoticeDeletionParams): void {
  const entry: PendingNoticeDeletion = {
    chatId,
    messageId,
    api,
    timer: setTimeout((): void => {
      // 先摘除再发请求：flush 与定时器只会有一个真正兑现这条公告。
      pendingNoticeDeletions.delete(entry);
      void deleteMessage(chatId, messageId, api);
    }, delayMs),
  };
  entry.timer.unref();
  pendingNoticeDeletions.add(entry);
}

/**
 * 停机前把还没到点的公告全部就地删掉。
 *
 * 删除动作登记进在途任务集合，好让 drain 等它们结算，因此**必须按「客户端 + 群」
 * 合批**：同一个群的请求全排在同一条限流桶里（1 请求/秒、maxConcurrent 1），
 * 逐条发的话 N 条至少要 N 秒才结算，而 drain 的预算是 ANTI_RAID_BARRIER_TIMEOUT_MS
 * 那一档的秒级数值——同一个群里几名成员在三分钟内接连刷屏就能攒出四条公告，
 * 足以让 drain 超时，生命周期据此拒绝确认 Telegram offset 并非零退出，重启后整批
 * update 被重投。讽刺的是触发它的正是这个「为了让停机更整洁」才加的清理步骤。
 * 合批之后同一个群只花一个请求，不同群之间本来就并行（限流按群分桶）。
 * 合批的理由与 adDetect/disposal.ts 完全一致：为的是**请求条数**，不是速度。
 *
 * 删失败只由统一错误边界记日志：公告没撤掉不该拦住停机。
 * @returns 本次兑现的条目数，便于测试与诊断。
 */
export function flushPendingNoticeDeletions(): number {
  const entries: PendingNoticeDeletion[] = [...pendingNoticeDeletions];
  pendingNoticeDeletions.clear();
  const batches: Map<Api, Map<number, number[]>> = new Map();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    let byChat: Map<number, number[]> | undefined = batches.get(entry.api);
    if (byChat === undefined) {
      byChat = new Map();
      batches.set(entry.api, byChat);
    }
    const messageIds: number[] | undefined = byChat.get(entry.chatId);
    if (messageIds === undefined) byChat.set(entry.chatId, [entry.messageId]);
    else messageIds.push(entry.messageId);
  }
  for (const [api, byChat] of batches) {
    for (const [chatId, messageIds] of byChat) {
      // deleteMessages 单次上限是 Bot API 的硬限制，超出整批被拒（该接口只有
      // 整体成败），因此照 adDetect/disposal.ts 的做法自行分片。
      for (let start: number = 0; start < messageIds.length; start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
        void trackAntiRaidTask({
          task: deleteMessages(
            chatId,
            messageIds.slice(start, start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX),
            api
          ),
        });
      }
    }
  }
  return entries.length;
}

/** Worker stop/测试隔离时丢掉册子与定时器；生产停机走 flush。 */
export function resetPendingNoticeDeletions(): void {
  for (const entry of pendingNoticeDeletions) clearTimeout(entry.timer);
  pendingNoticeDeletions.clear();
}
