import { Api, Bot, GrammyError, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { autoRetry } from "@grammyjs/auto-retry";
import { BOT_TOKEN } from "./config";

export const bot: Bot = new Bot(BOT_TOKEN);

/**
 * 专供入群验证流程（joinVerification.ts）使用的独立 API 客户端。该流程可能在
 * 几秒内向同一个群突发大量 send/delete/kick 调用——比如一波人同时入群，或者
 * 踢人时要把某个刷屏者的所有消息全部删掉。这里做了限流以符合 Telegram 的
 * 单聊天/全局限制，并在遇到 429 时自动重试，让这些突发请求排队等待而不是
 * 静默失败。与共享的 `bot.api` 客户端分开，避免给其他地方的普通指令回复
 * 增加延迟或排队。
 */
export const joinVerificationApi: Api = new Api(BOT_TOKEN);
joinVerificationApi.config.use(apiThrottler());
joinVerificationApi.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 5 }));

const AVATAR_FETCH_TIMEOUT_MS: number = 15000;
const AVATAR_FETCH_MAX_ATTEMPTS: number = 3;

/**
 * 下载某用户（或频道）的头像，并上传设置为本机器人的头像。
 * @param targetId 目标用户或频道 ID。
 * @param isChannel 目标是否为频道（频道要通过 getChat 而非 getUserProfilePhotos 获取头像）。
 * @returns 成功时 resolve 为 true，否则为 false。
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
 * 向指定 Telegram 聊天发送文本消息。
 * 重要：这里绝不能传 parse_mode。文本内容可能来自不受信任的用户（原样或反转后被
 * 复读回去），不设置 parse_mode 会让 Telegram 把它当作纯文本处理——不解析任何
 * HTML/MarkdownV2 实体，从而杜绝了格式/链接注入的可能。
 * @param chatId 目标聊天 ID。
 * @param text 消息文本。
 * @param replyToMessageId 可选，要回复的消息 ID。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 发送成功时返回该消息的 ID，失败则返回 undefined。
 */
export async function sendMessage(chatId: number, text: string, replyToMessageId?: number, api: Api = bot.api): Promise<number | undefined> {
  try {
    const sent = await api.sendMessage(
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
 * 删除一条消息。用于在用户未能及时通过入群验证时，清理相关痕迹
 * （提醒消息 + TA 期间发送的内容）。
 * @param chatId 消息所在的聊天。
 * @param messageId 要删除的消息。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function deleteMessage(chatId: number, messageId: number, api: Api = bot.api): Promise<void> {
  try {
    await api.deleteMessage(chatId, messageId);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      console.error(`Failed to delete message: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error deleting message:", error);
    }
  }
}

/** 踢人公告在被自动清理前保持可见的时长。 */
export const KICK_NOTICE_AUTO_DELETE_MS: number = 30 * 1000;

/**
 * 安排一条消息在延迟后被删除。触发即忘（fire-and-forget）——用于踢人公告，
 * 这类消息应当自行清理而不是一直留在聊天里。
 * @param chatId 消息所在的聊天。
 * @param messageId 要删除的消息。
 * @param delayMs 删除前等待的毫秒数。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export function deleteMessageAfter(chatId: number, messageId: number, delayMs: number, api: Api = bot.api): void {
  setTimeout(() => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs);
}

/**
 * 将某成员移出聊天但不永久封禁：先封禁再立刻解封，这样 TA 之后若再次被邀请
 * 仍可自由加入。需要机器人是拥有封禁权限的管理员。
 * @param chatId 要移出成员的聊天。
 * @param userId 要移除的成员。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function kickChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<void> {
  try {
    await api.banChatMember(chatId, userId);
    await api.unbanChatMember(chatId, userId, { only_if_banned: true });
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      console.error(`Failed to kick chat member: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error kicking chat member:", error);
    }
  }
}

/**
 * 将指定消息复制（复读）到目标聊天。
 * @param chatId 目标聊天 ID。
 * @param fromChatId 源聊天 ID。
 * @param messageId 要复制的消息 ID。
 */
export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.copyMessage(chatId, fromChatId, messageId);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      // Telegram 的错误详情（比如权限不足）都在 description 里，比只看 HTTP 状态更有用。
      console.error(`Failed to copy message: ${error.error_code} ${error.description}`);
    } else {
      console.error("Error copying message:", error);
    }
  }
}

/**
 * 设置（或在 `reactions` 为空时清除）本机器人对某条消息的 emoji 表情回应。
 * @param chatId 目标聊天 ID。
 * @param messageId 要回应的消息。
 * @param reactions 要应用的 emoji 回应（空数组表示移除机器人的回应）。
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
