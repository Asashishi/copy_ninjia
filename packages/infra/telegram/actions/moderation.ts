import type { Api } from "grammy";
import {
  MUTED_CHAT_PERMISSIONS,
  UNMUTED_CHAT_PERMISSIONS,
} from "../../../consts/telegram";
import { bot } from "../client";
import {
  isPermissionDenied,
  runBooleanTelegramAction,
  runTelegramAction,
  signalArgs,
} from "./core";

export interface MuteChatMemberParams {
  chatId: number;
  userId: number;
  /** 禁言结束的绝对时刻（ms）；这里换算成 Bot API 的 until_date（秒）。 */
  mutedUntil: number;
  api?: Api;
  signal?: AbortSignal;
}

export type MuteChatMemberOutcome =
  | "muted"
  | "forbidden"
  | "failed";

/**
 * 临时收走一名成员在本群的全部发言权限（到点由 Telegram 自动恢复）。
 * `until_date` 向上取整到秒，避免边界上被 Bot API 解释成永久限制。
 */
export async function muteChatMemberWithOutcome({
  chatId,
  userId,
  mutedUntil,
  api = bot.api,
  signal,
}: MuteChatMemberParams): Promise<MuteChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const muted: boolean = await runTelegramAction({
    action: `mute chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<true> =>
      api.restrictChatMember(
        chatId,
        userId,
        MUTED_CHAT_PERMISSIONS,
        { until_date: Math.ceil(mutedUntil / 1000) },
        ...signalArgs(requestSignal)
      ),
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (
      error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => {
      permissionDenied = isPermissionDenied(error);
      return actionSignal?.aborted !== true;
    },
  });
  if (muted) return "muted";
  return permissionDenied ? "forbidden" : "failed";
}

export interface UnmuteChatMemberParams {
  chatId: number;
  userId: number;
  api?: Api;
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
  api = bot.api,
  signal,
}: UnmuteChatMemberParams): Promise<UnmuteChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const unmuted: boolean = await runTelegramAction({
    action: `unmute chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<true> =>
      api.restrictChatMember(
        chatId,
        userId,
        UNMUTED_CHAT_PERMISSIONS,
        {},
        ...signalArgs(requestSignal)
      ),
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (
      error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => {
      permissionDenied = isPermissionDenied(error);
      return actionSignal?.aborted !== true;
    },
  });
  if (unmuted) return "unmuted";
  return permissionDenied ? "forbidden" : "failed";
}

/** 一次只踢不封请求的结局；权限拒绝与瞬时失败必须由长生命周期调用方区别处理。 */
export type KickChatMemberOutcome =
  | "kicked"
  | "forbidden"
  | "failed";

export interface KickChatMemberParams {
  chatId: number;
  userId: number;
  /**
   * 这个群是不是超级群；三态，**未知（省略）必须与确证的 false 区分**。
   *
   * 「只踢不封」在两类群里是两个不同的方法，Bot API 原文各自划定了作用域：
   * - `unbanChatMember`：「unban a previously banned user **in a supergroup or
   *   channel**」——普通群用不了；
   * - `banChatMember`：「ban a user in **a group**, a supergroup or a channel」，
   *   而「踢了就回不来」那句紧接着限定「**In the case of supergroups and
   *   channels**」——所以普通群里它就是一次纯移除，不留持久封禁。
   *
   * 因此只有**确证是普通群**才改走 `banChatMember`。未知时一律按超级群办：
   * 托管群绝大多数是超级群，把未知折算成普通群，代价是在超级群里打出一次真正
   * 的持久封禁，而「除 /block 与黑名单秒踢外一律只踢不封」是这套自动处置的硬
   * 约束（见 docs/04-invariants.md）。镜像来源见 antiRaid/chatKind.ts。
   */
  isSupergroup?: boolean;
  api?: Api;
}

/** 原子地将成员移出群聊但不加入封禁名单，并保留失败类别。 */
export async function kickChatMemberWithOutcome({
  chatId,
  userId,
  isSupergroup,
  api = bot.api,
}: KickChatMemberParams): Promise<KickChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const kicked: boolean = await runTelegramAction({
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
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      permissionDenied = isPermissionDenied(error);
      return true;
    },
  });
  if (kicked) return "kicked";
  return permissionDenied ? "forbidden" : "failed";
}

/** 只关心是否踢成功的兼容入口。 */
export async function kickChatMember(
  params: KickChatMemberParams
): Promise<boolean> {
  return (await kickChatMemberWithOutcome(params)) === "kicked";
}

/**
 * 一次封禁尝试的结局。`forbidden` 与 `failed` 必须分开：前者是「再试一次也
 * 一样」，后者是限流/网络抖动这类值得退避重试的失败。
 */
export type BanChatMemberOutcome =
  | "banned"
  | "forbidden"
  | "failed";

/** 封禁一名成员，并连带删除 TA 在这个群发过的全部消息。 */
export async function banChatMemberWithOutcome(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<BanChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const banned: boolean = await runTelegramAction({
    action: `ban chat member (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<true> =>
      signal === undefined
        ? api.banChatMember(chatId, userId, {
          revoke_messages: true,
        })
        : api.banChatMember(
          chatId,
          userId,
          { revoke_messages: true },
          signal as unknown as Parameters<Api["banChatMember"]>[3]
        ),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      permissionDenied = isPermissionDenied(error);
      return true;
    },
  });
  if (banned) return "banned";
  return permissionDenied ? "forbidden" : "failed";
}

/** 只关心成败的封禁入口；权限与偶发失败的区分见 banChatMemberWithOutcome。 */
export async function banChatMember(
  chatId: number,
  userId: number,
  api: Api = bot.api
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
  api: Api = bot.api
): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban chat member (chat ${chatId}, user ${userId})`,
    (signal?: AbortSignal): Promise<true> =>
      signal === undefined
        ? api.unbanChatMember(chatId, userId, {
          only_if_banned: true,
        })
        : api.unbanChatMember(
          chatId,
          userId,
          { only_if_banned: true },
          signal as unknown as Parameters<Api["unbanChatMember"]>[3]
        )
  );
}

/** 封禁频道马甲在本群的发言权，并保留权限拒绝与偶发失败的区别。 */
export async function banChatSenderChatWithOutcome(
  chatId: number,
  senderChatId: number,
  api: Api = bot.api
): Promise<BanChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const banned: boolean = await runTelegramAction({
    action: `ban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    execute: (signal?: AbortSignal): Promise<true> =>
      signal === undefined
        ? api.banChatSenderChat(chatId, senderChatId)
        : api.banChatSenderChat(
          chatId,
          senderChatId,
          signal as unknown as Parameters<
            Api["banChatSenderChat"]
          >[2]
        ),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      permissionDenied = isPermissionDenied(error);
      return true;
    },
  });
  if (banned) return "banned";
  return permissionDenied ? "forbidden" : "failed";
}

/** 只关心成败的频道马甲封禁入口。 */
export async function banChatSenderChat(
  chatId: number,
  senderChatId: number,
  api: Api = bot.api
): Promise<boolean> {
  return (
    await banChatSenderChatWithOutcome(chatId, senderChatId, api)
  ) === "banned";
}

/** 解除某个频道马甲在这个群的发言封禁。 */
export async function unbanChatSenderChat(
  chatId: number,
  senderChatId: number,
  api: Api = bot.api
): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    (signal?: AbortSignal): Promise<true> =>
      signal === undefined
        ? api.unbanChatSenderChat(chatId, senderChatId)
        : api.unbanChatSenderChat(
          chatId,
          senderChatId,
          signal as unknown as Parameters<
            Api["unbanChatSenderChat"]
          >[2]
        )
  );
}
