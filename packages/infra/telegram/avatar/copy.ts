import { GrammyError, InputFile } from "grammy";
import type { ChatFullInfo, PhotoSize, UserProfilePhotos } from "grammy/types";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_MAX_DOWNLOAD_BYTES,
  BOT_PROFILE_PHOTO_FILE_NAME,
  USER_PROFILE_PHOTOS_LIMIT,
} from "../../../consts/telegram";
import { readBoundedResponseBytes, type BoundedResponseResult } from "../../../libs/boundedResponse";
import { logger } from "../../logger";
import { logApiError } from "../client";
import { bot } from "../mainClient";
import type { HydratedTelegramFile } from "../mainClient";
import { runTelegramCategorizedRequest } from "../outboundGate";
import { avatarFetchSignal, telegramSignal } from "./shared";
import type { AvatarOperationAttemptResult } from "./shared";
import {
  extractPublicUsername,
  fetchAvatarFromWebProfile,
  normalizePublicUsername,
} from "./webProfile";

interface PublicUsernameLookupResult {
  username?: string;
  failed: boolean;
}

async function resolvePublicUsernameFromChat(
  targetId: number,
  isChannel: boolean,
  signal?: AbortSignal
): Promise<PublicUsernameLookupResult> {
  try {
    const chat: ChatFullInfo = await bot.api.getChat(targetId, telegramSignal(signal));
    return { username: extractPublicUsername(chat), failed: false };
  } catch (error: unknown) {
    if (signal?.aborted) return { failed: true };
    if (error instanceof GrammyError) {
      if (error.error_code === 403) {
        logger.error(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat: 403 Forbidden (chat is not accessible to the bot)`);
      } else {
        logger.error(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat: ${error.error_code} ${error.description}`);
      }
    } else {
      logger.error(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat:`, error);
    }
    return { failed: true };
  }
}

async function attemptCopyUserProfilePhoto(
  targetId: number,
  isChannel: boolean,
  signal?: AbortSignal
): Promise<AvatarOperationAttemptResult> {
  try {
    if (signal?.aborted) return "permanent-failure";
    let fileId: string;
    if (isChannel) {
      const chat: ChatFullInfo = await bot.api.getChat(targetId, telegramSignal(signal));
      if (!chat.photo) {
        logger.error(`Channel ${targetId} has no chat photo visible to the bot`);
        return "permanent-failure";
      }
      fileId = chat.photo.big_file_id;
    } else {
      // 两个请求互不依赖（activeUniqueId 在两者都返回后才被消费），并发
      // 缩短这条用户可见路径的往返延迟。用 allSettled 等两边都落定，任一
      // 失败再抛出原因，走外层 catch 原有的 transient-failure 语义。
      const [chatResult, photosResult]: [PromiseSettledResult<ChatFullInfo>, PromiseSettledResult<UserProfilePhotos>] = await Promise.allSettled([
        bot.api.getChat(targetId, telegramSignal(signal)),
        bot.api.getUserProfilePhotos(targetId, { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT }, telegramSignal(signal)),
      ]);
      if (chatResult.status === "rejected") throw chatResult.reason;
      if (photosResult.status === "rejected") throw photosResult.reason;
      const activeUniqueId: string | undefined = chatResult.value.photo?.big_file_unique_id;
      const photos: UserProfilePhotos = photosResult.value;
      if (photos.total_count === 0) {
        logger.error(`User ${targetId} has no profile photos visible to the bot (privacy settings or no avatar)`);
        return "permanent-failure";
      }

      const matchedPhoto: PhotoSize | undefined = activeUniqueId
        ? photos.photos.find((sizes: PhotoSize[]): boolean => sizes.length > 0 && sizes[sizes.length - 1]!.file_unique_id === activeUniqueId)?.at(-1)
        : undefined;
      if (!matchedPhoto) {
        logger.error(`Active avatar of user ${targetId} not found among their visible profile photos (no chat.photo, or history beyond first 100)`);
        return "permanent-failure";
      }
      fileId = matchedPhoto.file_id;
    }

    const file: HydratedTelegramFile = await bot.api.getFile(fileId, telegramSignal(signal));
    if (!file.file_path) {
      logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
      return "permanent-failure";
    }

    const downloadUrl: string = file.getUrl();
    const downloadSignal: AbortSignal = avatarFetchSignal(signal);
    const imgRes: Response = await runTelegramCategorizedRequest({
      category: "download",
      signal: downloadSignal,
      execute: (requestSignal: AbortSignal): Promise<Response> => fetch(downloadUrl, {
        redirect: "error",
        signal: requestSignal,
      }),
    });
    if (!imgRes.ok) {
      logger.error(`Failed to download avatar file (${imgRes.status}): ${file.file_path}`);
      return "transient-failure";
    }
    const download: BoundedResponseResult = await readBoundedResponseBytes(imgRes, AVATAR_MAX_DOWNLOAD_BYTES);
    if (!download.ok) {
      logger.error(`Avatar file exceeded the download limit (${download.observedBytes} bytes): ${file.file_path}`);
      return "permanent-failure";
    }

    await bot.api.setMyProfilePhoto(
      { type: "static", photo: new InputFile(download.bytes, BOT_PROFILE_PHOTO_FILE_NAME) },
      telegramSignal(signal)
    );
    return "ok";
  } catch (error: unknown) {
    if (signal?.aborted) return "permanent-failure";
    logApiError("copy user profile photo", error);
    return "transient-failure";
  }
}

/** 复制用户头像时由调用方提供的诊断线索和取消信号。 */
export interface CopyUserProfilePhotoOptions {
  /**
   * 调用方上下文里带的 username（回复目标、身份缓存），**只作诊断线索**，不作
   * 抓取目标——理由见 copyUserProfilePhoto 里那段注释。
   */
  username?: string;
  signal?: AbortSignal;
}

/**
 * 复制用户或频道的当前头像。优先通过 Bot API 精确匹配当前头像，失败后用
 * getChat 现查一次公开 username 抓取 t.me 页面兜底。
 */
export async function copyUserProfilePhoto(
  targetId: number,
  isChannel: boolean = false,
  options: CopyUserProfilePhotoOptions = {}
): Promise<boolean> {
  const { username, signal }: CopyUserProfilePhotoOptions = options;
  for (let attempt: number = 1; attempt <= AVATAR_FETCH_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return false;
    const result: AvatarOperationAttemptResult = await attemptCopyUserProfilePhoto(targetId, isChannel, signal);
    if (result === "ok") return true;
    logger.error(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
    if (result === "permanent-failure") break;
  }

  // 抓取目标只认 getChat 现查的结果，绝不用调用方给的那个。provided 值来自
  // reply_to_message（可能是三个月前的消息）或身份缓存，而 Telegram 用户名释放
  // 之后可以被任何人重新注册；抓取页面时的 hasMatchingProfileIdentity 只能证明
  // 「这个页面属于 @name」，证明不了「@name 此刻仍指向 targetId」。短路掉权威
  // 查询的后果是把**现任 @handle 持有者**的头像顶成机器人头像，而成功提示里
  // 写着原目标——一次谁都发现不了的张冠李戴。
  const lookup: PublicUsernameLookupResult = await resolvePublicUsernameFromChat(targetId, isChannel, signal);
  const fallbackUsername: string | undefined = lookup.username;
  if (fallbackUsername) {
    logger.error(`Falling back to t.me web profile scrape for @${fallbackUsername}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(fallbackUsername, signal);
    if (imgBuffer) {
      try {
        await bot.api.setMyProfilePhoto(
          { type: "static", photo: new InputFile(imgBuffer, BOT_PROFILE_PHOTO_FILE_NAME) },
          telegramSignal(signal)
        );
        return true;
      } catch (error: unknown) {
        if (signal?.aborted) return false;
        logApiError("set profile photo from web fallback", error);
      }
    }
  } else {
    // 命令上下文里的那个 username 只进日志：它可能已经易主，不能拿来抓页面。
    const providedUsername: string | undefined = normalizePublicUsername(username);
    const hint: string = providedUsername === undefined
      ? ""
      : ` (command context suggested @${providedUsername}, not used because it cannot be proven to still belong to this id)`;
    logger.error(
      lookup.failed
        ? `Skipping t.me web profile scrape fallback: getChat lookup for ${isChannel ? "channel" : "user"} ${targetId} failed${hint}`
        : `Skipping t.me web profile scrape fallback: ${isChannel ? "channel" : "user"} ${targetId} has no public username${hint}`
    );
  }
  return false;
}
