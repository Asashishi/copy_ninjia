import type { Api } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import { isAdminStatus } from "../../../libs/chatMember";
import { bot } from "../client";
import { runTelegramAction } from "./core";

function isPresentMember(member: ChatMember): boolean {
  if (member.status === "restricted") return member.is_member;
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member"
  );
}

/** 查询失败按非成员处理，避免在未确认时生成“已踢出”的错误战报。 */
export async function isChatMember(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<boolean> {
  return runTelegramAction({
    action: `check chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> =>
      signal === undefined
        ? api.getChatMember(chatId, userId)
        : api.getChatMember(
          chatId,
          userId,
          signal as unknown as Parameters<Api["getChatMember"]>[2]
        ),
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
  api: Api = bot.api
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> =>
      signal === undefined
        ? api.getChatMember(chatId, userId)
        : api.getChatMember(
          chatId,
          userId,
          signal as unknown as Parameters<Api["getChatMember"]>[2]
        ),
    map: isPresentMember,
    fallback: undefined,
  });
}

/**
 * 目标此刻是不是这个群的管理员/群主。
 * @returns 确认是管理员 true、确认不是 false、查询失败 undefined。
 */
export async function probeChatAdmin(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat admin (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> =>
      signal === undefined
        ? api.getChatMember(chatId, userId)
        : api.getChatMember(
          chatId,
          userId,
          signal as unknown as Parameters<Api["getChatMember"]>[2]
        ),
    map: (member: ChatMember): boolean =>
      isAdminStatus(member.status),
    fallback: undefined,
  });
}
