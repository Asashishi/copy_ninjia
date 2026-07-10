import { Bot, GrammyError, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { BOT_TOKEN } from "./config";

export const bot: Bot = new Bot(BOT_TOKEN);

const AVATAR_FETCH_TIMEOUT_MS: number = 15000;
const AVATAR_FETCH_MAX_ATTEMPTS: number = 3;

/**
 * Downloads a user's (or channel's) profile photo and uploads it as the bot's profile photo.
 * @param targetId The target user or channel ID.
 * @param isChannel Whether the target is a channel (channels expose their avatar via getChat, not getUserProfilePhotos).
 * @returns A promise resolving to true if successful, false otherwise.
 */
export async function copyUserProfilePhoto(targetId: number, isChannel: boolean = false): Promise<boolean> {
  for (let attempt: number = 1; attempt <= AVATAR_FETCH_MAX_ATTEMPTS; attempt++) {
    const success: boolean = await attemptCopyUserProfilePhoto(targetId, isChannel);
    if (success) return true;
    console.error(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
  }
  return false;
}

async function attemptCopyUserProfilePhoto(targetId: number, isChannel: boolean): Promise<boolean> {
  try {
    let fileId: string;

    if (isChannel) {
      // 频道没有 getUserProfilePhotos，只能通过 getChat 的 photo 字段拿头像（只有大小两档，无需再挑最大尺寸）
      const chat = await bot.api.getChat(targetId);
      if (!chat.photo) {
        return false;
      }
      fileId = chat.photo.big_file_id;
    } else {
      // 获取用户当前选中的头像（offset=0 即为用户当前正在使用的那张头像）
      const photos = await bot.api.getUserProfilePhotos(targetId, { offset: 0, limit: 1 });
      if (photos.total_count === 0) {
        return false;
      }

      const photoSizes = photos.photos[0];
      if (!photoSizes || photoSizes.length === 0) {
        return false;
      }

      // 按照 Telegram API 约定，同一张头像的多个尺寸按分辨率从小到大排列，
      // 因此数组最后一个元素即为分辨率最高（原图）的版本；不要用 file_size 比较，
      // 因为 file_size 是可选字段，缺失时会导致误选到缩略图。
      const largestPhoto = photoSizes[photoSizes.length - 1]!;
      fileId = largestPhoto.file_id;
    }

    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      return false;
    }

    // 下载文件内容（grammY 没有内置下载封装，仍需自己 fetch 原始字节）
    const downloadUrl: string = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const imgRes: Response = await fetch(downloadUrl, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) {
      console.error(`Failed to download file from ${downloadUrl}`);
      return false;
    }
    const imgBuffer: Uint8Array = new Uint8Array(await imgRes.arrayBuffer());

    await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") });
    return true;
  } catch (error: unknown) {
    console.error("Error copying user profile photo:", error);
    return false;
  }
}

/**
 * Sends a text message to a specific Telegram chat.
 * IMPORTANT: never pass a parse_mode here. The text can originate from an
 * untrusted user (and is echoed back verbatim/reversed), so leaving parse_mode
 * unset makes Telegram treat it as inert plain text — no HTML/MarkdownV2
 * entities are parsed, which closes off markup/link injection.
 * @param chatId The target chat ID.
 * @param text The message text.
 * @param replyToMessageId Optional message ID to reply to.
 * @returns The sent message's ID, or undefined if sending failed.
 */
export async function sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<number | undefined> {
  try {
    const sent = await bot.api.sendMessage(
      chatId,
      text,
      replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : undefined
    );
    return sent.message_id;
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      console.error(`Failed to send message: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error sending message:", error);
    }
    return undefined;
  }
}

/**
 * Deletes a message. Used to scrub a join-verification attempt (reminder +
 * whatever the user sent) when they fail to verify in time.
 * @param chatId The chat containing the message.
 * @param messageId The message to delete.
 */
export async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      console.error(`Failed to delete message: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error deleting message:", error);
    }
  }
}

/** How long a kick announcement stays visible before it's cleaned up automatically. */
export const KICK_NOTICE_AUTO_DELETE_MS: number = 30 * 1000;

/**
 * Schedules a message for deletion after a delay. Fire-and-forget — used for
 * kick announcements, which should self-clean instead of lingering in the chat.
 * @param chatId The chat containing the message.
 * @param messageId The message to delete.
 * @param delayMs Milliseconds to wait before deleting.
 */
export function deleteMessageAfter(chatId: number, messageId: number, delayMs: number): void {
  setTimeout(() => {
    void deleteMessage(chatId, messageId);
  }, delayMs);
}

/**
 * Removes a member from a chat without permanently banning them: a ban
 * immediately followed by an unban, so they're free to rejoin later if
 * invited again. Requires the bot to be an admin with ban rights.
 * @param chatId The chat to remove the member from.
 * @param userId The member to remove.
 */
export async function kickChatMember(chatId: number, userId: number): Promise<void> {
  try {
    await bot.api.banChatMember(chatId, userId);
    await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      console.error(`Failed to kick chat member: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error kicking chat member:", error);
    }
  }
}

/**
 * Copies (repeats) a specific message into the target chat.
 * @param chatId The target chat ID.
 * @param fromChatId The source chat ID.
 * @param messageId The ID of the message to copy.
 */
export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.copyMessage(chatId, fromChatId, messageId);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      // Telegram 的错误详情（比如权限不足）都在 description 里，比只看 HTTP 状态更有用
      console.error(`Failed to copy message: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error copying message:", error);
    }
  }
}

/**
 * Sets (or clears, if `reactions` is empty) the bot's own emoji reaction on a message.
 * @param chatId The target chat ID.
 * @param messageId The message to react to.
 * @param reactions The emoji reactions to apply (empty array removes the bot's reaction).
 */
export async function setReaction(chatId: number, messageId: number, reactions: ReactionTypeEmoji[]): Promise<void> {
  try {
    await bot.api.setMessageReaction(chatId, messageId, reactions);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      console.error(`Failed to set message reaction: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error setting message reaction:", error);
    }
  }
}
