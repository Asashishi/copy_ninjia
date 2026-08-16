import { existsSync } from "node:fs";
import { Bot, GrammyError } from "grammy";
import type { ChatFullInfo, User } from "@grammyjs/types";
import { BOT_TOKEN } from "../../packages/config/telegram";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { STATE_FILE_PATH } from "../../packages/consts/paths";
import { assertTelegramChatId } from
  "../../packages/database/codec/chatState";
import { readJsonInput } from "../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../packages/libs/record";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import type { ChatState } from "../../packages/types/chatState";
import type {
  TelegramIdentityMetadata,
  WhitelistPermissions,
} from "../../packages/types/identityPolicy";
import type { MigrationInput } from "../../packages/types/identityStorageMigration";
import { decodePreviousChatState } from "../chatStateMigration/previousState";
import type { PreviousChatState } from "../chatStateMigration/previousState";

/** Telegram 补全后的迁移输入；只允许明确 kicked 的白名单群实体被丢弃。 */
export interface QueriedMigrationInput {
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly droppedKickedWhitelistCount: number;
}

function managedChatIds(): readonly number[] {
  if (!existsSync(STATE_FILE_PATH)) return [];
  const value: unknown = readJsonInput(STATE_FILE_PATH);
  if (!isPlainRecord(value) || !hasExactKeys(value, ["chats", "global"])) {
    throw new Error(
      `${STATE_FILE_PATH}: $ must be the legacy chats/global migration shape.`
    );
  }
  // 这里只是一次性旧结构迁移入口；运行时代码仍严格拒绝 chats 顶层。
  decodeStateFile({ global: value.global });
  if (!isPlainRecord(value.chats)) {
    throw new Error(`${STATE_FILE_PATH}: $.chats must be an object.`);
  }
  const entries: [string, unknown][] = Object.entries(value.chats);
  if (entries.length > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${STATE_FILE_PATH}: $.chats must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats.`
    );
  }
  const ids: number[] = [];
  for (const [chatIdText, rawState] of entries) {
    const chatId: number = Number(chatIdText);
    const rowSource: string = `${STATE_FILE_PATH}:$.chats.${chatIdText}`;
    if (String(chatId) !== chatIdText) {
      throw new Error(`${rowSource}: chat ID key must be canonical.`);
    }
    assertTelegramChatId(chatId, rowSource);
    const previous: PreviousChatState = decodePreviousChatState(
      rawState,
      rowSource
    );
    const stateEntry: ChatState = previous.state;
    if (stateEntry.isInitEnabled === true) ids.push(chatId);
  }
  return ids;
}

function metadataFromUser(
  user: User
): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: user.first_name,
    lastName: user.last_name ?? "",
    username: user.username ?? "",
  };
}

function metadataFromChat(
  chat: ChatFullInfo
): Readonly<TelegramIdentityMetadata> | undefined {
  if ("first_name" in chat) {
    return {
      firstName: chat.first_name ?? "",
      lastName: "last_name" in chat ? chat.last_name ?? "" : "",
      username: "username" in chat ? chat.username ?? "" : "",
    };
  }
  if ("title" in chat) {
    return {
      firstName: chat.title,
      lastName: "",
      username: "username" in chat ? chat.username ?? "" : "",
    };
  }
  return undefined;
}

async function queryIdentityMetadata(
  bot: Bot,
  id: number,
  chatIds: readonly number[]
): Promise<Readonly<TelegramIdentityMetadata> | null> {
  try {
    const chat: ChatFullInfo = await bot.api.getChat(id);
    const direct: Readonly<TelegramIdentityMetadata> | undefined =
      metadataFromChat(chat);
    if (direct !== undefined) return direct;
  } catch (error: unknown) {
    if (isBotKickedFromChatError(error)) return null;
    // 正用户 ID 继续走托管群 getChatMember；最终仍解析不到时统一致命退出。
  }
  if (id > 0) {
    for (const chatId of chatIds) {
      try {
        const member: Awaited<ReturnType<typeof bot.api.getChatMember>> =
          await bot.api.getChatMember(chatId, id);
        return metadataFromUser(member.user);
      } catch {
        // 该群不可见或用户不在群时继续下一群，不把 API payload 写入日志。
      }
    }
  }
  throw new Error(
    `Telegram API could not resolve required metadata for identity ${id}.`
  );
}

/** 只识别 getChat 明确报告的机器人被群/频道踢出；其它 403 不能删除名单。 */
export function isBotKickedFromChatError(error: unknown): boolean {
  return error instanceof GrammyError &&
    error.method === "getChat" &&
    error.error_code === 403 &&
    /^Forbidden: bot was kicked from the (?:group|supergroup|channel) chat$/.test(
      error.description
    );
}

/** 顺序查询名单元数据，保持 Telegram 请求有界且不并发冲击所有托管群。 */
export async function queryAllMetadata(
  input: MigrationInput
): Promise<QueriedMigrationInput> {
  const bot: Bot = new Bot(BOT_TOKEN);
  const chatIds: readonly number[] = managedChatIds();
  const metadata: Map<number, Readonly<TelegramIdentityMetadata>> = new Map();
  const whitelist: Map<number, Readonly<WhitelistPermissions>> =
    new Map(input.whitelist);
  const ids: readonly number[] = [...new Set<number>([
    ...whitelist.keys(),
    ...input.blockedIds,
  ])];
  let droppedKickedWhitelistCount: number = 0;
  for (const id of ids) {
    const resolved: Readonly<TelegramIdentityMetadata> | null =
      await queryIdentityMetadata(bot, id, chatIds);
    if (resolved !== null) {
      metadata.set(id, resolved);
      continue;
    }
    if (!whitelist.delete(id)) {
      throw new Error(
        `Telegram reports that the bot was kicked from blocklisted identity ${id}; ` +
        "refusing to drop a blocklist entry."
      );
    }
    droppedKickedWhitelistCount++;
  }
  return {
    input: {
      whitelist,
      blockedIds: input.blockedIds,
      removals: input.removals,
    },
    metadata,
    droppedKickedWhitelistCount,
  };
}
