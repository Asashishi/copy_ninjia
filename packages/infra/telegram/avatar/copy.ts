import { GrammyError } from "grammy";
import type { ChatFullInfo, PhotoSize, UserProfilePhotos } from "grammy/types";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  USER_PROFILE_PHOTOS_LIMIT,
} from "../../../consts/telegram";
import { logger } from "../../logger";
import { logApiError } from "../client";
import { bot } from "../mainClient";
import { telegramSignal } from "../../../libs/telegramSignal";
import { downloadAvatarFile } from "./download";
import type { AvatarDownloadResult } from "../../../types/telegram";
import { avatarFailureFor, runAvatarFetchAttempts, setBotProfilePhoto } from "./shared";
import type {
  AvatarFetchAttemptsOutcome,
  AvatarOperationAttemptResult,
} from "./shared";
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
        logger.warn(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat: 403 Forbidden (chat is not accessible to the bot)`);
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
        logger.log(`Channel ${targetId} has no chat photo visible to the bot`);
        return "permanent-failure";
      }
      fileId = chat.photo.big_file_id;
    } else {
      // 两个请求并发发出，allSettled 等两边都落定，任一失败再抛出原因，
      // 由外层 catch 按 avatarFailureFor 分类。
      const [chatResult, photosResult]: [PromiseSettledResult<ChatFullInfo>, PromiseSettledResult<UserProfilePhotos>] = await Promise.allSettled([
        bot.api.getChat(targetId, telegramSignal(signal)),
        bot.api.getUserProfilePhotos(targetId, { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT }, telegramSignal(signal)),
      ]);
      if (chatResult.status === "rejected") throw chatResult.reason;
      if (photosResult.status === "rejected") throw photosResult.reason;
      const activeUniqueId: string | undefined = chatResult.value.photo?.big_file_unique_id;
      const photos: UserProfilePhotos = photosResult.value;
      if (photos.total_count === 0) {
        logger.log(`User ${targetId} has no profile photos visible to the bot (privacy settings or no avatar)`);
        return "permanent-failure";
      }

      const matchedPhoto: PhotoSize | undefined = activeUniqueId
        ? photos.photos.find((sizes: PhotoSize[]): boolean => sizes.length > 0 && sizes[sizes.length - 1]!.file_unique_id === activeUniqueId)?.at(-1)
        : undefined;
      if (!matchedPhoto) {
        logger.log(`Active avatar of user ${targetId} not found among their visible profile photos (no chat.photo, or history beyond first 100)`);
        return "permanent-failure";
      }
      fileId = matchedPhoto.file_id;
    }

    const download: AvatarDownloadResult = await downloadAvatarFile(fileId, targetId, signal);
    if (download.status !== "ok") return download.status;

    await setBotProfilePhoto(download.bytes, "static", signal);
    return "ok";
  } catch (error: unknown) {
    if (signal?.aborted) return "permanent-failure";
    logApiError("copy user profile photo", error);
    return avatarFailureFor(error);
  }
}

/** 复制用户头像时由调用方提供的诊断线索和取消信号。 */
export interface CopyUserProfilePhotoOptions {
  /**
   * 调用方上下文里带的 username（回复目标、身份缓存），只作诊断线索，不作抓取目标。
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
  const outcome: AvatarFetchAttemptsOutcome = await runAvatarFetchAttempts(
    async (attempt: number): Promise<AvatarOperationAttemptResult> => {
      const result: AvatarOperationAttemptResult = await attemptCopyUserProfilePhoto(targetId, isChannel, signal);
      if (result !== "ok") {
        logger.log(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
      }
      return result;
    },
    signal
  );
  if (outcome === "ok") return true;
  if (outcome === "aborted") return false;

  // 抓取目标只取 getChat 现查的结果，不用调用方给的 username（它来自回复目标或
  // 身份缓存，不能证明仍指向 targetId）。
  const lookup: PublicUsernameLookupResult = await resolvePublicUsernameFromChat(targetId, isChannel, signal);
  const fallbackUsername: string | undefined = lookup.username;
  if (fallbackUsername) {
    logger.log(`Falling back to t.me web profile scrape for @${fallbackUsername}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(fallbackUsername, signal);
    if (imgBuffer) {
      try {
        await setBotProfilePhoto(imgBuffer, "static", signal);
        return true;
      } catch (error: unknown) {
        if (signal?.aborted) return false;
        logApiError("set profile photo from web fallback", error);
      }
    }
  } else {
    // 命令上下文里的 username 只进日志，不用于抓取。
    const providedUsername: string | undefined = normalizePublicUsername(username);
    const hint: string = providedUsername === undefined
      ? ""
      : ` (command context suggested @${providedUsername}, not used because it cannot be proven to still belong to this id)`;
    logger.warn(
      lookup.failed
        ? `Skipping t.me web profile scrape fallback: getChat lookup for ${isChannel ? "channel" : "user"} ${targetId} failed${hint}`
        : `Skipping t.me web profile scrape fallback: ${isChannel ? "channel" : "user"} ${targetId} has no public username${hint}`
    );
  }
  return false;
}
