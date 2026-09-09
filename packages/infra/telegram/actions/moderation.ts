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
import { signalArgs } from "../../../libs/telegramSignalArgs";
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
   * 从算好 `mutedUntil` 到请求真正发出的容忍上限；到期即放弃这次禁言。
   *
   * **必填，不设缺省**：`until_date` 是入队前算好的绝对时刻，而 restrict 请求
   * 命中 429 后会在独立车道按 `retry_after` 无上界等待。排到 `until_date` 距当下
   * 不足 30 秒时 Bot API 把它当成**永久限制**，而本仓库两条禁言路径都不排恢复
   * 计时器、不写任何持久化状态——那就是一次只能人工 `/unmute` 的永久禁言，
   * 回执却照常念「到点自动松开」。放弃这次禁言的代价远小于此。
   *
   * 具体预算按各自的最短时长由调用方给出：刷屏禁言用
   * `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`，`/mute` 用
   * `时长 - MUTE_DISPATCH_MIN_REMAINING_MS`（两处常量各自写明取值理由）。
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
 * `until_date` 向上取整到秒，护的是**下**边界的亚秒那一头：Bot API 把「距现在
 * 不足 30 秒」当永久限制，向下取整会把亚秒余数抹掉、让时长比调用方要的更短。
 * 同一条下边界的**排队**那一头由 `dispatchTimeoutMs` 兜（见该字段）。上边界
 * （超过 366 天同样按永久处理）由 MUTE_MAX_DURATION_MS 留出的一整天余量兜
 * ——取整最多加 1 秒，排队和往返的耗时也远小于那道余量，两头都不会滑出合法区间。
 *
 * 派发截止在本函数内与调用方 signal 合成，不由调用点各自 `signalWithTimeout`：
 * 「带 until_date 的禁言必须有派发截止」是这个操作本身的契约，写在类型上才不会
 * 有第三个调用点漏掉它。
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
        ...signalArgs(requestSignal)
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
        ...signalArgs(requestSignal)
      ),
    signal,
  });
  if (outcome === "succeeded") return "unmuted";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

/** 一次只踢不封请求的结局；权限拒绝与瞬时失败必须由长生命周期调用方区别处理。 */
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
   * 「只踢不封」在两类群里是两个不同的方法，Bot API 原文各自划定了作用域：
   * - `unbanChatMember`：「unban a previously banned user **in a supergroup or
   *   channel**」——普通群用不了；
   * - `banChatMember`：「ban a user in **a group**, a supergroup or a channel」，
   *   而「踢了就回不来」那句紧接着限定「**In the case of supergroups and
   *   channels**」——所以普通群里它就是一次纯移除，不留持久封禁。
   *
   * 因此确证普通群走 `banChatMember`，确证超级群走 `unbanChatMember`。类型侧
   * 强制调用方给出布尔值，避免把冷启动未知默认为任一边（见
   * docs/cn/04-invariants.md 与 antiRaid/chatKind.ts）。
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
          ...signalArgs(signal)
        )
        : api.unbanChatMember(
          chatId,
          userId,
          {},
          ...signalArgs(signal)
        ),
    // 「目标已经不在群」不是故障，也不该被解释成权限拒绝：认领掉它，既不记
    // API 错误，也不让调用方按可重试失败退避。
    claimError: isTelegramRetryPreconditionChanged,
  });
  if (outcome === "succeeded") return "kicked";
  if (outcome === "claimed") return "absent";
  return outcome === "forbidden" ? "forbidden" : "failed";
}

/**
 * 一次封禁尝试的结局。`forbidden` 与 `failed` 必须分开：前者是「再试一次也
 * 一样」，后者是限流/网络抖动这类值得退避重试的失败。
 */
export type BanChatMemberOutcome =
  | "banned"
  | "forbidden"
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
        ...signalArgs(signal)
      ),
  });
  if (outcome === "succeeded") return "banned";
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
 * 解除某人在这个群的封禁。`only_if_banned` 不能省，否则当前仍是群成员的目标
 * 会被 unbanChatMember 移出群聊。
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
        ...signalArgs(signal)
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
      api.banChatSenderChat(chatId, senderChatId, ...signalArgs(signal)),
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
      api.unbanChatSenderChat(chatId, senderChatId, ...signalArgs(signal))
  );
}
