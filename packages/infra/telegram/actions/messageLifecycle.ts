import type { ReactionTypeEmoji } from "@grammyjs/types";
import { telegramApi } from "../client";
import {
  inFlightMessageDeletions,
  pendingMessageDeletions,
} from "../../../cache/perThread/messageDeletion";
import { logger } from "../../logger";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../../../libs/monotonicDeadline";
import {
  settleWithinBudget,
  trackBackgroundTask,
} from "../../../libs/backgroundTasks";
import {
  isPermissionDenied,
  runBooleanTelegramAction,
  runTelegramAction,
  signalArgs,
} from "./core";
import type {
  PendingMessageDeletion,
  TelegramMessageDeletionApi,
} from "../../../types/telegram";
import type { FlushResult } from "../../../types/lifecycle";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../../consts/telegram";
import { telegramErrorDetails } from "../errors";
import type { TelegramApi } from "../../../types/telegramWorker";

type MessageReactionApi = Pick<TelegramApi, "setMessageReaction">;
type EphemeralMessageDeletionApi = Pick<TelegramApi, "deleteEphemeralMessage">;

export interface DeleteEphemeralMessageParams {
  chatId: number;
  receiverUserId: number;
  ephemeralMessageId: number;
  api?: EphemeralMessageDeletionApi;
}

export interface SetMessageReactionParams {
  chatId: number;
  messageId: number;
  emoji: string;
  api?: MessageReactionApi;
  signal?: AbortSignal;
}

/** 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应；仅 API 落地成功时返回 true。 */
export async function setMessageReaction({
  chatId,
  messageId,
  emoji,
  api = telegramApi,
  signal,
}: SetMessageReactionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    "set message reaction",
    (requestSignal?: AbortSignal): Promise<true> =>
      api.setMessageReaction(
        chatId,
        messageId,
        [{
          type: "emoji",
          emoji: emoji as ReactionTypeEmoji["emoji"],
        }],
        {},
        ...signalArgs(requestSignal)
      ),
    signal
  );
}

/**
 * 一次删除尝试的结局。`gone` 与 `failed` 必须分开：调用方拿删除结果去写群内
 * 文案或错误日志时，「这条消息已经不在了」和「本机器人删不动它」是两件相反的
 * 事，混成一个布尔会冤枉权限配置正确的管理员。
 */
export type DeleteMessageOutcome =
  | "deleted"
  | "gone"
  | "forbidden"
  | "failed";

/** Telegram 是否明确说了「这条消息不存在或不可删」，而不是拒绝权限或偶发失败。 */
function isMessageGone(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details?.errorCode !== 400) {
    return false;
  }
  return /message to delete not found|ephemeral message (?:to delete )?not found|message can'?t be deleted/i.test(
    details.description
  );
}

/** 按群、接收者与临时消息 id 删除目标专属消息，并保留与普通删除相同的四态。 */
export async function deleteEphemeralMessageWithOutcome(
  {
    chatId,
    receiverUserId,
    ephemeralMessageId,
    api = telegramApi,
  }: DeleteEphemeralMessageParams
): Promise<DeleteMessageOutcome> {
  let gone: boolean = false;
  let permissionDenied: boolean = false;
  const deleted: boolean = await runTelegramAction({
    action: "delete ephemeral message",
    execute: (signal?: AbortSignal): Promise<true> =>
      api.deleteEphemeralMessage({
        chatId,
        receiverUserId,
        ephemeralMessageId,
      }, ...signalArgs(signal)),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      gone = isMessageGone(error);
      permissionDenied = !gone && isPermissionDenied(error);
      return !gone;
    },
  });
  if (deleted) return "deleted";
  if (gone) return "gone";
  return permissionDenied ? "forbidden" : "failed";
}

/** 删一条消息并保留 deleted/gone/forbidden/failed 四态结局。 */
export async function deleteMessageWithOutcome(
  chatId: number,
  messageId: number,
  api: Pick<TelegramApi, "deleteMessage"> = telegramApi
): Promise<DeleteMessageOutcome> {
  let gone: boolean = false;
  let permissionDenied: boolean = false;
  const deleted: boolean = await runTelegramAction({
    action: "delete message",
    execute: (signal?: AbortSignal): Promise<true> =>
      api.deleteMessage(chatId, messageId, ...signalArgs(signal)),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      gone = isMessageGone(error);
      permissionDenied = isPermissionDenied(error);
      // 「消息已经不在了」不是故障：删痕迹这条路上它甚至是常态。
      return !gone;
    },
  });
  if (deleted) return "deleted";
  if (gone) return "gone";
  return permissionDenied ? "forbidden" : "failed";
}

export async function deleteMessage(
  chatId: number,
  messageId: number,
  api: Pick<TelegramApi, "deleteMessage"> = telegramApi
): Promise<boolean> {
  const outcome: DeleteMessageOutcome =
    await deleteMessageWithOutcome(chatId, messageId, api);
  // 「消息已经不在了」对只看成败的调用方就是成功。
  return outcome === "deleted" || outcome === "gone";
}

/**
 * 一次删掉同一个群里的多条消息。单次上限 100 条，且与 deleteMessage 一样只能删
 * 48 小时内的；超出由调用方分片，删不掉的个别消息 Telegram 自行跳过。
 */
export async function deleteMessages(
  chatId: number,
  messageIds: readonly number[],
  api: Pick<TelegramApi, "deleteMessages"> = telegramApi
): Promise<boolean> {
  if (messageIds.length === 0) return true;
  return runBooleanTelegramAction(
    "delete messages",
    (signal?: AbortSignal): Promise<true> =>
      api.deleteMessages(
        chatId,
        [...messageIds],
        ...signalArgs(signal)
      )
  );
}

export interface DeleteMessageAfterParams {
  chatId: number;
  messageId: number;
  delayMs: number;
  api?: TelegramMessageDeletionApi;
  /** 停机提前兑现时按客户端与群合批；正常到期仍只删除本条。 */
  batchOnFlush?: boolean;
}

/** 认领一条待删消息并启动统一 Telegram 删除；timer 与停机 drain 只会成功一次。 */
function startMessageDeletion(entry: PendingMessageDeletion): void {
  if (!pendingMessageDeletions.delete(entry)) return;
  clearTimeout(entry.timer);
  trackMessageDeletion(deleteMessage(entry.chatId, entry.messageId, entry.api));
}

/** 把一条已启动的删除接入统一在途集合；请求异常不会逃出清理边界。 */
function trackMessageDeletion(request: Promise<boolean>): void {
  // 常规 API 错误已由 runTelegramAction 记录；这层只兜住边界自身的意外异常。
  trackBackgroundTask(
    inFlightMessageDeletions,
    request,
    "Unexpected error in delayed Telegram message deletion:"
  );
}

/** 停机路径认领同客户端、同群的一批条目，并按 Bot API 硬上限发一次删除。 */
function startMessageDeletionBatch(
  entries: readonly PendingMessageDeletion[],
  api: TelegramMessageDeletionApi,
  chatId: number
): void {
  const messageIds: number[] = [];
  for (const entry of entries) {
    if (!pendingMessageDeletions.delete(entry)) continue;
    clearTimeout(entry.timer);
    messageIds.push(entry.messageId);
  }
  if (messageIds.length > 0) {
    trackMessageDeletion(deleteMessages(chatId, messageIds, api));
  }
}

/** 延迟删除登记在册，timer 不阻止退出；正常停机由 drain 提前兑现。 */
export function deleteMessageAfter({
  chatId,
  messageId,
  delayMs,
  api = telegramApi,
  batchOnFlush = false,
}: DeleteMessageAfterParams): void {
  const entry: PendingMessageDeletion = {
    chatId,
    messageId,
    api,
    batchOnFlush,
    timer: setTimeout((): void => startMessageDeletion(entry), delayMs),
  };
  entry.timer.unref();
  pendingMessageDeletions.add(entry);
}

/**
 * 立即认领全部未到期条目，并返回本线程当前所有在途删除句柄。Worker 可把这些
 * Promise 接入自己的 task tracker；主线程 drain 也复用它，避免两套兑现逻辑。
 */
export function flushPendingMessageDeletions(): readonly Promise<void>[] {
  const batches: Map<TelegramMessageDeletionApi, Map<number, PendingMessageDeletion[]>> = new Map();
  for (const entry of [...pendingMessageDeletions]) {
    if (!entry.batchOnFlush) {
      startMessageDeletion(entry);
      continue;
    }
    let byChat: Map<number, PendingMessageDeletion[]> | undefined =
      batches.get(entry.api);
    if (byChat === undefined) {
      byChat = new Map();
      batches.set(entry.api, byChat);
    }
    const entries: PendingMessageDeletion[] | undefined =
      byChat.get(entry.chatId);
    if (entries === undefined) byChat.set(entry.chatId, [entry]);
    else entries.push(entry);
  }
  for (const [api, byChat] of batches) {
    for (const [chatId, entries] of byChat) {
      for (
        let start: number = 0;
        start < entries.length;
        start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX
      ) {
        startMessageDeletionBatch(
          entries.slice(start, start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX),
          api,
          chatId
        );
      }
    }
  }
  return [...inFlightMessageDeletions];
}

/**
 * 正常停机前提前兑现本线程全部延迟删除，并等待已开始的删除请求。预算为零时不
 * 新建网络请求；超时只记诊断并返回，不让非功能性清理无限阻止退出。
 */
export async function drainPendingMessageDeletions(timeoutMs: number): Promise<FlushResult> {
  if (timeoutMs <= 0 && (pendingMessageDeletions.size > 0 || inFlightMessageDeletions.size > 0)) {
    return "timedOut";
  }
  const deadline: number = createMonotonicDeadline(timeoutMs);
  while (pendingMessageDeletions.size > 0 || inFlightMessageDeletions.size > 0) {
    void flushPendingMessageDeletions();
    if (inFlightMessageDeletions.size === 0) continue;
    const remaining: number = remainingMonotonicTime(deadline);
    if (
      remaining === 0 ||
      !await settleWithinBudget([...inFlightMessageDeletions], remaining)
    ) {
      logger.error(
        `Delayed Telegram message deletion drain timed out with ` +
        `${pendingMessageDeletions.size} pending and ${inFlightMessageDeletions.size} in flight.`
      );
      return "timedOut";
    }
  }
  return "flushed";
}

/** 测试隔离/线程销毁时清理尚未触发的 timer；已发出的请求只能自然结算。 */
export function resetPendingMessageDeletions(): void {
  for (const entry of pendingMessageDeletions) clearTimeout(entry.timer);
  pendingMessageDeletions.clear();
}
