import { GrammyError } from "grammy";
import type { Api } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { bot } from "../client";
import {
  isPermissionDenied,
  runBooleanTelegramAction,
  runTelegramAction,
  signalArgs,
} from "./core";

export interface SetMessageReactionParams {
  chatId: number;
  messageId: number;
  emoji: string;
  api?: Api;
  signal?: AbortSignal;
}

/** 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应；仅 API 落地成功时返回 true。 */
export async function setMessageReaction({
  chatId,
  messageId,
  emoji,
  api = bot.api,
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
  if (!(error instanceof GrammyError) || error.error_code !== 400) {
    return false;
  }
  return /message to delete not found|message can'?t be deleted/i.test(
    error.description
  );
}

/** 删一条消息并保留 deleted/gone/forbidden/failed 四态结局。 */
export async function deleteMessageWithOutcome(
  chatId: number,
  messageId: number,
  api: Api = bot.api
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
  api: Api = bot.api
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
  api: Api = bot.api
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
  api?: Api;
}

/** 延迟删除用于公告清理，不让这类美化任务阻止进程退出。 */
export function deleteMessageAfter({
  chatId,
  messageId,
  delayMs,
  api = bot.api,
}: DeleteMessageAfterParams): void {
  setTimeout((): void => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs).unref();
}
