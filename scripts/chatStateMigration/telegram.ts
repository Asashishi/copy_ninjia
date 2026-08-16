/** 冷迁移对上一版 `botIsAdmin` 的 Telegram 完整权限补全。 */

import { Bot } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import { BOT_TOKEN } from "../../packages/config/telegram";
import { STATE_FILE_PATH } from "../../packages/consts/paths";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { readBotChatPermissions } from "../../packages/libs/chatMember";
import type { BotChatPermissions } from "../../packages/types/telegram";

/** 可注入的单群机器人成员查询；生产使用 grammY，测试使用隔离替身。 */
export type ReadBotChatMember = (chatId: number) => Promise<ChatMember>;

/**
 * 顺序补全最多 25 个群的权限，避免冷迁移同时向 Telegram 打满一批请求。
 * 任一群无法确证都停止，不用旧管理员布尔值猜具体权限。
 */
export async function collectPreviousBotPermissions(
  chatIds: readonly number[],
  readMember: ReadBotChatMember
): Promise<ReadonlyMap<number, Readonly<BotChatPermissions>>> {
  if (chatIds.length > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${STATE_FILE_PATH}: $.chats must contain at most ` +
      `${STATE_MANAGED_CHAT_LIMIT} chats before querying Telegram permissions.`
    );
  }
  const permissions: Map<number, Readonly<BotChatPermissions>> = new Map();
  for (const chatId of chatIds) {
    let member: ChatMember;
    try {
      member = await readMember(chatId);
    } catch (error: unknown) {
      throw new Error(
        `${STATE_FILE_PATH}: $.chats.${chatId}.botIsAdmin must resolve to the bot's complete current Telegram permissions.`,
        { cause: error }
      );
    }
    permissions.set(chatId, readBotChatPermissions(member));
  }
  return permissions;
}

/** 用当前部署 token 查询机器人身份及其在各上一版群记录中的完整权限。 */
export async function queryPreviousBotPermissions(
  chatIds: readonly number[]
): Promise<ReadonlyMap<number, Readonly<BotChatPermissions>>> {
  if (chatIds.length === 0) return new Map();
  const bot: Bot = new Bot(BOT_TOKEN);
  try {
    await bot.init();
  } catch (error: unknown) {
    throw new Error(
      `${STATE_FILE_PATH}: Telegram bot identity must be resolvable before chat-state cold migration.`,
      { cause: error }
    );
  }
  return collectPreviousBotPermissions(
    chatIds,
    (chatId: number): Promise<ChatMember> =>
      bot.api.getChatMember(chatId, bot.botInfo.id)
  );
}
