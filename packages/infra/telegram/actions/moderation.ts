import {
  MUTED_CHAT_PERMISSIONS,
  UNMUTED_CHAT_PERMISSIONS,
} from "../../../consts/telegram";
import type { TelegramApi } from "../../../types/telegramWorker";
import { telegramApi } from "../client";
import {
  runBooleanTelegramAction,
  runPermissionAwareTelegramAction,
} from "./core";
import { telegramSignal } from "../../../libs/telegramSignal";
import { signalWithTimeout } from "../../../libs/abortSignal";
import type { PermissionAwareOutcome } from "./core";
import { isTelegramRetryPreconditionChanged } from "../errors";

type RestrictMemberApi = Pick<TelegramApi, "restrictChatMember">;
type KickMemberApi = Pick<TelegramApi, "banChatMember" | "unbanChatMember">;
type BanMemberApi = Pick<TelegramApi, "banChatMember">;
type UnbanMemberApi = Pick<TelegramApi, "unbanChatMember">;
type BanSenderChatApi = Pick<TelegramApi, "banChatSenderChat">;
type UnbanSenderChatApi = Pick<TelegramApi, "unbanChatSenderChat">;

export interface MuteChatMemberParams {
  chatId: number;
  userId: number;
  /** 禁言结束的绝对时刻（ms）；这里换算成 Bot API 的 until_date（秒）。 */
  mutedUntil: number;
  /**
   * 从算好 `mutedUntil` 到请求真正发出的容忍上限；到期即放弃这次禁言。必填，不设缺省。
   *
   * `until_date` 是入队前算好的绝对时刻，restrict 请求命中 429 后在独立车道按
   * `retry_after` 等待；派发截止限制这段排队时间，使发出时的 `until_date` 不会过于
   * 接近当下（Bot API 对此类值按永久限制处理）。
   *
   * 具体预算按各自的最短时长由调用方给出：刷屏禁言用
   * `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`，`/mute` 用
   * `时长 - MUTE_DISPATCH_MIN_REMAINING_MS`（两处常量各自写明取值）。
   */
  dispatchTimeoutMs: number;
  api?: RestrictMemberApi;
  /** 调用方自己的取消源（停机、update 取消等）；与上面的派发截止合成后下传。 */
  signal?: AbortSignal;
}

export type MuteChatMemberOutcome =
  | "muted"
  | "forbidden"
  | "failed";

/**
 * 临时收走一名成员在本群的全部发言权限（到点由 Telegram 自动恢复）。
 *
 * `until_date` 向上取整到秒。Bot API 允许区间的下边界由 `dispatchTimeoutMs`
 * 约束排队时间，上边界由 MUTE_MAX_DURATION_MS 留出的余量覆盖取整、排队与往返耗时。
 *
 * 派发截止在本函数内与调用方 signal 合成（`signalWithTimeout`），由必填字段
 * `dispatchTimeoutMs` 强制，调用点不各自合成。
 */
export async function muteChatMemberWithOutcome({
  chatId,
  userId,
  mutedUntil,
  dispatchTimeoutMs,
  api = telegramApi,
  signal,
}: MuteChatMemberParams): Promise<MuteChatMemberOutcome> {
  const outcome: PermissionAwareOutcome = await runPermissionAwareTelegramAction({
    action: `mute chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<true> =>
      api.restrictChatMember(
        chatId,
        userId,
        MUTED_CHAT_PERMISSIONS,
        { until_date: Math.ceil(mutedUntil / 1000) },
        telegramSignal(requestSignal)
      ),
    signal: signalWithTimeout(signal, dispatchTimeoutMs),
  });
  if (outcome === "succeeded") return "muted";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

export interface UnmuteChatMemberParams {
  chatId: number;
  userId: number;
  api?: RestrictMemberApi;
  signal?: AbortSignal;
}

export type UnmuteChatMemberOutcome =
  | "unmuted"
  | "forbidden"
  | "failed";

/** 提前恢复一名成员在本群的发言权限。 */
export async function unmuteChatMemberWithOutcome({
  chatId,
  userId,
  api = telegramApi,
  signal,
}: UnmuteChatMemberParams): Promise<UnmuteChatMemberOutcome> {
  const outcome: PermissionAwareOutcome = await runPermissionAwareTelegramAction({
    action: `unmute chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<true> =>
      api.restrictChatMember(
        chatId,
        userId,
        UNMUTED_CHAT_PERMISSIONS,
        {},
        telegramSignal(requestSignal)
      ),
    signal,
  });
  if (outcome === "succeeded") return "unmuted";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

/** 一次只踢不封请求的结局；权限拒绝与瞬时失败分开返回。 */
export type KickChatMemberOutcome =
  | "kicked"
  | "absent"
  | "forbidden"
  | "failed";

export interface KickChatMemberParams {
  chatId: number;
  userId: number;
  /**
   * 这个群是不是超级群；调用前必须精确解析，未知不得授权破坏性动作。
   *
   * 「只踢不封」在两类群里用不同的方法：确证普通群走 `banChatMember`（普通群里它是一次
   * 纯移除，不留持久封禁），确证超级群走 `unbanChatMember`（Bot API 将其限定在超级群
   * 或频道）。类型侧强制调用方给出布尔值（见 docs/cn/04-invariants.md 与
   * antiRaid/chatKind.ts）。
   */
  isSupergroup: boolean;
  api?: KickMemberApi;
}

/** 原子地将成员移出群聊但不加入封禁名单，并保留失败类别。 */
export async function kickChatMemberWithOutcome({
  chatId,
  userId,
  isSupergroup,
  api = telegramApi,
}: KickChatMemberParams): Promise<KickChatMemberOutcome> {
  const outcome: PermissionAwareOutcome = await runPermissionAwareTelegramAction({
    action: `kick chat member (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<true> =>
      isSupergroup === false
        ? api.banChatMember(
          chatId,
          userId,
          {},
          telegramSignal(signal)
        )
        : api.unbanChatMember(
          chatId,
          userId,
          {},
          telegramSignal(signal)
        ),
    // 「目标已经不在群」由 claimError 认领：不记 API 错误，结局为 absent。
    claimError: isTelegramRetryPreconditionChanged,
  });
  if (outcome === "succeeded") return "kicked";
  if (outcome === "claimed") return "absent";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

/**
 * 一次封禁尝试的结局。`forbidden` 是权限拒绝，`failed` 是限流、网络抖动等偶发失败。
 * `participantInvalid` 是 Telegram 以 PARTICIPANT_ID_INVALID 拒绝这个用户 ID，
 * 只由真人封禁产生。
 */
export type BanChatMemberOutcome =
  | "banned"
  | "forbidden"
  | "participantInvalid"
  | "failed";

/** 封禁一名成员，并撤销被移除成员对既有群消息的访问。 */
export async function banChatMemberWithOutcome(
  chatId: number,
  userId: number,
  api: BanMemberApi = telegramApi
): Promise<BanChatMemberOutcome> {
  const outcome: PermissionAwareOutcome = await runPermissionAwareTelegramAction({
    action: `ban chat member (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<true> =>
      api.banChatMember(
        chatId,
        userId,
        { revoke_messages: true },
        telegramSignal(signal)
      ),
  });
  if (outcome === "succeeded") return "banned";
  if (outcome === "participantInvalid") return "participantInvalid";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

/** 只关心成败的封禁入口；权限与偶发失败的区分见 banChatMemberWithOutcome。 */
export async function banChatMember(
  chatId: number,
  userId: number,
  api: BanMemberApi = telegramApi
): Promise<boolean> {
  return (
    await banChatMemberWithOutcome(chatId, userId, api)
  ) === "banned";
}

/**
 * 解除某人在这个群的封禁。请求带 `only_if_banned`，目标当前仍是群成员时不会被
 * 移出群聊。
 */
export async function unbanChatMemberIfBanned(
  chatId: number,
  userId: number,
  api: UnbanMemberApi = telegramApi
): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban chat member (chat ${chatId}, user ${userId})`,
    (signal?: AbortSignal): Promise<true> =>
      api.unbanChatMember(
        chatId,
        userId,
        { only_if_banned: true },
        telegramSignal(signal)
      )
  );
}

/** 封禁频道马甲在本群的发言权，并保留权限拒绝与偶发失败的区别。 */
export async function banChatSenderChatWithOutcome(
  chatId: number,
  senderChatId: number,
  api: BanSenderChatApi = telegramApi
): Promise<BanChatMemberOutcome> {
  const outcome: PermissionAwareOutcome = await runPermissionAwareTelegramAction({
    action: `ban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    execute: (signal?: AbortSignal): Promise<true> =>
      api.banChatSenderChat(chatId, senderChatId, telegramSignal(signal)),
  });
  if (outcome === "succeeded") return "banned";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

/** 只关心成败的频道马甲封禁入口。 */
export async function banChatSenderChat(
  chatId: number,
  senderChatId: number,
  api: BanSenderChatApi = telegramApi
): Promise<boolean> {
  return (
    await banChatSenderChatWithOutcome(chatId, senderChatId, api)
  ) === "banned";
}

/** 解除某个频道马甲在这个群的发言封禁。 */
export async function unbanChatSenderChat(
  chatId: number,
  senderChatId: number,
  api: UnbanSenderChatApi = telegramApi
): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    (signal?: AbortSignal): Promise<true> =>
      api.unbanChatSenderChat(chatId, senderChatId, telegramSignal(signal))
  );
}
