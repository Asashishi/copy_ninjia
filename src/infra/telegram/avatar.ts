import { GrammyError, InputFile } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_FETCH_TIMEOUT_MS,
  AVATAR_MAX_DOWNLOAD_BYTES,
  PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES,
  USER_PROFILE_PHOTOS_LIMIT,
} from "../../consts/telegram";
import { readBoundedResponseBytes, readBoundedResponseText, type BoundedResponseResult } from "../../libs/boundedResponse";
import { logger } from "../logger";
import { bot, buildFileDownloadUrl, logApiError } from "./client";

interface PublicUsernameLookupResult {
  username?: string;
  failed: boolean;
}

/** 单次头像复制尝试的结果：区分可重试故障与确定性失败。 */
type AvatarCopyAttemptResult = "ok" | "transient-failure" | "permanent-failure";

/** 去掉首尾空白和多余的 @，空结果视为没有公开用户名。 */
export function normalizePublicUsername(username: string | undefined): string | undefined {
  const normalized: string | undefined = username?.trim().replace(/^@+/, "");
  return normalized || undefined;
}

/** 从 getChat 响应中优先提取 username，再尝试 active_usernames。 */
export function extractPublicUsername(chat: unknown): string | undefined {
  if (!chat || typeof chat !== "object") return undefined;
  const maybeChat = chat as { username?: unknown; active_usernames?: unknown };
  if (typeof maybeChat.username === "string") {
    const username: string | undefined = normalizePublicUsername(maybeChat.username);
    if (username) return username;
  }
  if (Array.isArray(maybeChat.active_usernames)) {
    for (const activeUsername of maybeChat.active_usernames) {
      if (typeof activeUsername !== "string") continue;
      const username: string | undefined = normalizePublicUsername(activeUsername);
      if (username) return username;
    }
  }
  return undefined;
}

/**
 * 从 t.me 公开主页提取头像 HTTPS URL。先定位头像 img，再读取 src，避免页面
 * 上其它图片或属性顺序变化造成误匹配。
 */
export function extractAvatarUrlFromProfileHtml(html: string): string | undefined {
  const imgTagMatch = /<img[^>]*class="[^"]*tgme_page_photo_image[^"]*"[^>]*>/.exec(html);
  const srcMatch = imgTagMatch?.[0].match(/src="([^"]+)"/);
  const photoUrl: string | undefined = srcMatch?.[1];
  return photoUrl?.startsWith("https://") ? photoUrl : undefined;
}

async function resolvePublicUsernameFromChat(targetId: number, isChannel: boolean): Promise<PublicUsernameLookupResult> {
  try {
    const chat = await bot.api.getChat(targetId);
    return { username: extractPublicUsername(chat), failed: false };
  } catch (error: unknown) {
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

/** 从 t.me 公开主页下载头像，页面或图片异常时返回 null。 */
export async function fetchAvatarFromWebProfile(username: string): Promise<Uint8Array | null> {
  try {
    const pageRes: Response = await fetch(`https://telegram.me/${encodeURIComponent(username)}`, {
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!pageRes.ok) {
      logger.error(`Failed to fetch telegram.me profile page for @${username}: ${pageRes.status}`);
      return null;
    }
    const html: string | null = await readBoundedResponseText(pageRes, PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES);
    if (html === null) {
      logger.error(`telegram.me profile page for @${username} exceeded the download limit`);
      return null;
    }

    const photoUrl: string | undefined = extractAvatarUrlFromProfileHtml(html);
    if (!photoUrl) {
      logger.error(`No profile photo found on t.me page for @${username}`);
      return null;
    }

    const imgRes: Response = await fetch(photoUrl, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) {
      logger.error(`Failed to download avatar from ${photoUrl}: ${imgRes.status}`);
      return null;
    }
    const download: BoundedResponseResult = await readBoundedResponseBytes(imgRes, AVATAR_MAX_DOWNLOAD_BYTES);
    if (!download.ok) {
      logger.error(`Avatar for @${username} exceeded the download limit (${download.observedBytes} bytes)`);
      return null;
    }
    return download.bytes;
  } catch (error: unknown) {
    logger.error(`Error scraping t.me profile photo for @${username}:`, error);
    return null;
  }
}

async function attemptCopyUserProfilePhoto(targetId: number, isChannel: boolean): Promise<AvatarCopyAttemptResult> {
  try {
    let fileId: string;
    if (isChannel) {
      const chat = await bot.api.getChat(targetId);
      if (!chat.photo) {
        logger.error(`Channel ${targetId} has no chat photo visible to the bot`);
        return "permanent-failure";
      }
      fileId = chat.photo.big_file_id;
    } else {
      // 两个请求互不依赖（activeUniqueId 在两者都返回后才被消费），并发
      // 缩短这条用户可见路径的往返延迟。用 allSettled 等两边都落定，任一
      // 失败再抛出原因，走外层 catch 原有的 transient-failure 语义。
      const [chatResult, photosResult] = await Promise.allSettled([
        bot.api.getChat(targetId),
        bot.api.getUserProfilePhotos(targetId, { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT }),
      ]);
      if (chatResult.status === "rejected") throw chatResult.reason;
      if (photosResult.status === "rejected") throw photosResult.reason;
      const activeUniqueId: string | undefined = chatResult.value.photo?.big_file_unique_id;
      const photos = photosResult.value;
      if (photos.total_count === 0) {
        logger.error(`User ${targetId} has no profile photos visible to the bot (privacy settings or no avatar)`);
        return "permanent-failure";
      }

      const matchedPhoto = activeUniqueId
        ? photos.photos.find((sizes) => sizes.length > 0 && sizes[sizes.length - 1]!.file_unique_id === activeUniqueId)?.at(-1)
        : undefined;
      if (!matchedPhoto) {
        logger.error(`Active avatar of user ${targetId} not found among their visible profile photos (no chat.photo, or history beyond first 100)`);
        return "permanent-failure";
      }
      fileId = matchedPhoto.file_id;
    }

    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
      return "permanent-failure";
    }

    const downloadUrl: string = buildFileDownloadUrl(file.file_path);
    const imgRes: Response = await fetch(downloadUrl, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) {
      logger.error(`Failed to download avatar file (${imgRes.status}): ${file.file_path}`);
      return "transient-failure";
    }
    const download: BoundedResponseResult = await readBoundedResponseBytes(imgRes, AVATAR_MAX_DOWNLOAD_BYTES);
    if (!download.ok) {
      logger.error(`Avatar file exceeded the download limit (${download.observedBytes} bytes): ${file.file_path}`);
      return "permanent-failure";
    }

    await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(download.bytes, "avatar.jpg") });
    return "ok";
  } catch (error: unknown) {
    logApiError("copy user profile photo", error);
    return "transient-failure";
  }
}

/**
 * 复制用户或频道的当前头像。优先通过 Bot API 精确匹配当前头像，失败后使用
 * 调用方提供或 getChat 补查到的公开 username 抓取 t.me 页面兜底。
 */
export async function copyUserProfilePhoto(targetId: number, isChannel: boolean = false, username?: string): Promise<boolean> {
  for (let attempt: number = 1; attempt <= AVATAR_FETCH_MAX_ATTEMPTS; attempt++) {
    const result: AvatarCopyAttemptResult = await attemptCopyUserProfilePhoto(targetId, isChannel);
    if (result === "ok") return true;
    logger.error(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
    if (result === "permanent-failure") break;
  }

  const providedUsername: string | undefined = normalizePublicUsername(username);
  const lookup: PublicUsernameLookupResult = providedUsername
    ? { username: providedUsername, failed: false }
    : await resolvePublicUsernameFromChat(targetId, isChannel);
  const fallbackUsername: string | undefined = lookup.username;
  if (fallbackUsername) {
    logger.error(`Falling back to t.me web profile scrape for @${fallbackUsername}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(fallbackUsername);
    if (imgBuffer) {
      try {
        await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") });
        return true;
      } catch (error: unknown) {
        logApiError("set profile photo from web fallback", error);
      }
    }
  } else {
    logger.error(
      lookup.failed
        ? `Skipping t.me web profile scrape fallback: ${isChannel ? "channel" : "user"} ${targetId} has no public username available from command context, and getChat lookup failed`
        : `Skipping t.me web profile scrape fallback: ${isChannel ? "channel" : "user"} ${targetId} has no public username available`
    );
  }
  return false;
}
