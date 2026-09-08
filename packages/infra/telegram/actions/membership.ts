import type { ChatMember, User } from "grammy/types";
import { isAdminStatus, isPresentMember } from "../../../libs/chatMember";
import { telegramApi } from "../client";
import { runTelegramAction } from "./core";
import { signalArgs } from "../../../libs/telegramSignalArgs";
import type { TelegramApi } from "../../../types/telegramWorker";

type ChatMemberApi = Pick<TelegramApi, "getChatMember">;

interface GetChatMemberOptions {
  readonly api: ChatMemberApi;
  readonly chatId: number;
  readonly userId: number;
  /** 缺省表示本次调用不参与取消，必须整个省略第三个参数。 */
  readonly signal?: AbortSignal;
}

/**
 * getChatMember 的唯一调用点。grammY 把 signal 放在第三个位置，而 TelegramApi
 * 只暴露 grammY 的 `Other` 形态；没有 signal 时省略该参数，不能传 undefined。
 */
function getChatMember({
  api,
  chatId,
  userId,
  signal,
}: GetChatMemberOptions): Promise<ChatMember> {
  return api.getChatMember(chatId, userId, ...signalArgs(signal));
}

/** 查询失败按非成员处理，避免在未确认时生成“已踢出”的错误战报。 */
export async function isChatMember(
  chatId: number,
  userId: number,
  api: ChatMemberApi = telegramApi
): Promise<boolean> {
  return runTelegramAction({
    action: `check chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api, chatId, userId, signal }),
    map: isPresentMember,
    fallback: false,
  });
}

/**
 * 把「确认不在群」与「查询失败」分开。
 * @returns 在群 true、确认不在群 false、查询失败 undefined。
 */
export async function probeChatMembership(
  chatId: number,
  userId: number,
  api: ChatMemberApi = telegramApi
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api, chatId, userId, signal }),
    map: isPresentMember,
    fallback: undefined,
  });
}

/** 管理员探测共用客户端与请求取消边界。 */
export interface ProbeChatAdminOptions {
  readonly chatId: number;
  readonly userId: number;
  readonly api?: ChatMemberApi;
  readonly signal?: AbortSignal;
}

/**
 * 目标此刻是不是这个群或频道的管理员/所有者。
 * @returns 确认是管理员 true、确认不是 false、查询失败 undefined。
 */
export async function probeChatAdmin(
  { chatId, userId, api = telegramApi, signal }: ProbeChatAdminOptions
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat admin (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api, chatId, userId, signal: requestSignal }),
    map: (member: ChatMember): boolean =>
      isAdminStatus(member.status),
    fallback: undefined,
    signal,
  });
}

/** 取成员身份的两条路共用的查询边界：是否解释成员状态由各自的 map 决定。 */
export interface ChatMemberUserOptions {
  readonly chatId: number;
  readonly userId: number;
  readonly signal?: AbortSignal;
}

/**
 * 取本轮查询到的成员身份，不解释成员状态，离群与被踢同样返回身份。
 * /wed 的候选信源只有 memory/wed 的已发言成员集合，抽中后只用这一次查询拿到
 * 图注和公开头像兜底所需的身份，见 commands/wed/draw.ts。
 * @returns 查询成功返回身份，查询失败返回 undefined。
 */
export function readChatMemberUser({ chatId, userId, signal }: ChatMemberUserOptions): Promise<User | undefined> {
  return runTelegramAction<ChatMember, User | undefined>({
    action: `read chat member identity (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api: telegramApi, chatId, userId, signal: requestSignal }),
    map: (member: ChatMember): User => member.user,
    fallback: undefined,
    signal,
  });
}

/** 返回此刻在群内的用户；null 表示已离群，undefined 表示查询失败。 */
export function readPresentChatUser({ chatId, userId, signal }: ChatMemberUserOptions): Promise<User | null | undefined> {
  return runTelegramAction<ChatMember, User | null | undefined>({
    action: `read chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api: telegramApi, chatId, userId, signal: requestSignal }),
    map: (member: ChatMember): User | null => isPresentMember(member) ? member.user : null,
    fallback: undefined,
    signal,
  });
}
