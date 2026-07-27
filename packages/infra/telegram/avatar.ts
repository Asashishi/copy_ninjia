import { GrammyError, InputFile } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_FETCH_TIMEOUT_MS,
  AVATAR_MAX_DOWNLOAD_BYTES,
  PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES,
  TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES,
  USER_PROFILE_PHOTOS_LIMIT,
} from "../../consts/telegram";
import { readBoundedResponseBytes, readBoundedResponseText, type BoundedResponseResult } from "../../libs/boundedResponse";
import { parseAllowedHttpsUrl } from "../../libs/httpUrlPolicy";
import { logger } from "../logger";
import { bot, buildFileDownloadUrl, logApiError } from "./client";
import type { ChatFullInfo, PhotoSize, UserProfilePhotos, File as TelegramFile } from "@grammyjs/types";

interface PublicUsernameLookupResult {
  username?: string;
  failed: boolean;
}

interface ParsedHtmlTag {
  name: string;
  attributes: ReadonlyMap<string, string>;
}

/** 单次头像复制尝试的结果：区分可重试故障与确定性失败。 */
type AvatarCopyAttemptResult = "ok" | "transient-failure" | "permanent-failure";

function avatarFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeout: AbortSignal = AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function telegramSignal(signal?: AbortSignal): Parameters<typeof bot.api.getChat>[1] {
  return signal as unknown as Parameters<typeof bot.api.getChat>[1];
}

/** 去掉首尾空白和多余的 @，空结果视为没有公开用户名。 */
export function normalizePublicUsername(username: string | undefined): string | undefined {
  const normalized: string | undefined = username?.trim().replace(/^@+/, "");
  return normalized || undefined;
}

/** 从 getChat 响应中优先提取 username，再尝试 active_usernames。 */
export function extractPublicUsername(chat: unknown): string | undefined {
  if (!chat || typeof chat !== "object") return undefined;
  const maybeChat: { username?: unknown; active_usernames?: unknown } = chat;
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

/** 只解码 URL 和 HTML 属性中会用到的实体，未知或无效实体保持原样。 */
function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity: string): string => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&quot;": return '"';
      case "&apos;": return "'";
      case "&lt;": return "<";
      case "&gt;": return ">";
    }

    const hexadecimal: boolean = entity[2]?.toLowerCase() === "x";
    const digits: string = entity.slice(hexadecimal ? 3 : 2, -1);
    const codePoint: number = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

/** 解析 img/meta/link 起始标签；页面正文已在进入这里前受到字节硬顶限制。 */
function parseRelevantHtmlTags(html: string): ParsedHtmlTag[] {
  const tags: ParsedHtmlTag[] = [];
  for (const tagMatch of html.matchAll(/<(img|meta|link)\b[^>]*>/gi)) {
    const rawTag: string = tagMatch[0];
    const attributes: Map<string, string> = new Map();
    const tagNameEnd: number = rawTag.search(/[\s/>]/);
    const attributeSource: string = tagNameEnd === -1 ? "" : rawTag.slice(tagNameEnd, -1);
    const attributePattern: RegExp = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attributeMatch of attributeSource.matchAll(attributePattern)) {
      const name: string = attributeMatch[1]!.toLowerCase();
      if (attributes.has(name)) continue;
      const value: string = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
      attributes.set(name, decodeHtmlAttribute(value));
    }
    tags.push({ name: tagMatch[1]!.toLowerCase(), attributes });
  }
  return tags;
}

function parseHttpsUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url: URL = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function parseTelegramAssetUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  return parseAllowedHttpsUrl({
    input: value.trim(),
    policy: { allowedHostnameSuffixes: TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES },
  }) ?? undefined;
}

function hasAttributeToken(attributes: ReadonlyMap<string, string>, name: string, expected: string): boolean {
  return attributes.get(name)?.split(/\s+/).some((token: string): boolean => token.toLowerCase() === expected) ?? false;
}

function isMetaKind(attributes: ReadonlyMap<string, string>, expected: string): boolean {
  return [attributes.get("property"), attributes.get("name")]
    .some((value: string | undefined): boolean => value?.trim().toLowerCase() === expected);
}

function isMatchingHttpsProfileUrl(value: string | undefined, expectedUsername: string): boolean {
  const url: URL | undefined = parseHttpsUrl(value);
  if (!url || url.port || url.search || url.hash) return false;
  const hostname: string = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "t.me" && hostname !== "telegram.me") return false;

  try {
    const pathname: string = decodeURIComponent(url.pathname).replace(/\/$/, "");
    return pathname.toLowerCase() === `/${expectedUsername.toLowerCase()}`;
  } catch {
    return false;
  }
}

function isMatchingTelegramDeepLink(value: string | undefined, expectedUsername: string): boolean {
  if (!value) return false;
  try {
    const url: URL = new URL(value.trim());
    if (url.protocol !== "tg:" || url.hostname.toLowerCase() !== "resolve" || url.pathname || url.port || url.username || url.password || url.hash) {
      return false;
    }
    const queryEntries: [string, string][] = [...url.searchParams.entries()];
    return queryEntries.length === 1 &&
      queryEntries[0]![0] === "domain" &&
      queryEntries[0]![1].toLowerCase() === expectedUsername.toLowerCase();
  } catch {
    return false;
  }
}

function isProfileIdentityMeta(attributes: ReadonlyMap<string, string>): boolean {
  return [
    "og:url",
    "al:ios:url",
    "al:android:url",
    "twitter:app:url:iphone",
    "twitter:app:url:ipad",
    "twitter:app:url:googleplay",
  ].some((kind: string): boolean => isMetaKind(attributes, kind));
}

function hasMatchingProfileIdentity(tags: readonly ParsedHtmlTag[], expectedUsername: string): boolean {
  return tags.some(({ name, attributes }: ParsedHtmlTag): boolean => {
    if (name === "meta" && isProfileIdentityMeta(attributes)) {
      const content: string | undefined = attributes.get("content");
      return isMatchingHttpsProfileUrl(content, expectedUsername) || isMatchingTelegramDeepLink(content, expectedUsername);
    }
    if (name === "link" && hasAttributeToken(attributes, "rel", "canonical")) {
      return isMatchingHttpsProfileUrl(attributes.get("href"), expectedUsername);
    }
    return false;
  });
}

/**
 * 从 t.me 公开主页提取头像 HTTPS URL。优先使用头像 class；语义 meta 回退
 * 只有在页面身份与目标 username 完全匹配时才启用，避免误取挑战页分享图。
 */
export function extractAvatarUrlFromProfileHtml(html: string, expectedUsername?: string): string | undefined {
  const tags: ParsedHtmlTag[] = parseRelevantHtmlTags(html);
  for (const { name, attributes } of tags) {
    if (name !== "img" || !hasAttributeToken(attributes, "class", "tgme_page_photo_image")) continue;
    const photoUrl: URL | undefined = parseTelegramAssetUrl(attributes.get("src"));
    if (photoUrl) return photoUrl.href;
  }

  const normalizedUsername: string | undefined = normalizePublicUsername(expectedUsername);
  if (!normalizedUsername || !hasMatchingProfileIdentity(tags, normalizedUsername)) return undefined;
  for (const metaKind of ["og:image", "twitter:image"] as const) {
    for (const { name, attributes } of tags) {
      if (name !== "meta" || !isMetaKind(attributes, metaKind)) continue;
      const photoUrl: URL | undefined = parseTelegramAssetUrl(attributes.get("content"));
      if (photoUrl) return photoUrl.href;
    }
  }
  return undefined;
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

/** 从 t.me 公开主页下载头像，页面或图片异常时返回 null。 */
export async function fetchAvatarFromWebProfile(username: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const pageRes: Response = await fetch(`https://telegram.me/${encodeURIComponent(username)}`, {
      redirect: "error",
      signal: avatarFetchSignal(signal),
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

    const photoUrl: string | undefined = extractAvatarUrlFromProfileHtml(html, username);
    if (!photoUrl) {
      logger.error(`No profile photo found on t.me page for @${username}`);
      return null;
    }

    const imgRes: Response = await fetch(photoUrl, {
      redirect: "error",
      signal: avatarFetchSignal(signal),
    });
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
    if (signal?.aborted) return null;
    logger.error(`Error scraping t.me profile photo for @${username}:`, error);
    return null;
  }
}

async function attemptCopyUserProfilePhoto(
  targetId: number,
  isChannel: boolean,
  signal?: AbortSignal
): Promise<AvatarCopyAttemptResult> {
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

    const file: TelegramFile = await bot.api.getFile(fileId, telegramSignal(signal));
    if (!file.file_path) {
      logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
      return "permanent-failure";
    }

    const downloadUrl: string = buildFileDownloadUrl(file.file_path);
    const imgRes: Response = await fetch(downloadUrl, { signal: avatarFetchSignal(signal) });
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
      { type: "static", photo: new InputFile(download.bytes, "avatar.jpg") },
      telegramSignal(signal)
    );
    return "ok";
  } catch (error: unknown) {
    if (signal?.aborted) return "permanent-failure";
    logApiError("copy user profile photo", error);
    return "transient-failure";
  }
}

/**
 * 复制用户或频道的当前头像。优先通过 Bot API 精确匹配当前头像，失败后使用
 * 调用方提供或 getChat 补查到的公开 username 抓取 t.me 页面兜底。
 */
export interface CopyUserProfilePhotoOptions {
  username?: string;
  signal?: AbortSignal;
}

export async function copyUserProfilePhoto(
  targetId: number,
  isChannel: boolean = false,
  options: CopyUserProfilePhotoOptions = {}
): Promise<boolean> {
  const { username, signal }: CopyUserProfilePhotoOptions = options;
  for (let attempt: number = 1; attempt <= AVATAR_FETCH_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return false;
    const result: AvatarCopyAttemptResult = await attemptCopyUserProfilePhoto(targetId, isChannel, signal);
    if (result === "ok") return true;
    logger.error(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
    if (result === "permanent-failure") break;
  }

  const providedUsername: string | undefined = normalizePublicUsername(username);
  const lookup: PublicUsernameLookupResult = providedUsername
    ? { username: providedUsername, failed: false }
    : await resolvePublicUsernameFromChat(targetId, isChannel, signal);
  const fallbackUsername: string | undefined = lookup.username;
  if (fallbackUsername) {
    logger.error(`Falling back to t.me web profile scrape for @${fallbackUsername}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(fallbackUsername, signal);
    if (imgBuffer) {
      try {
        await bot.api.setMyProfilePhoto(
          { type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") },
          telegramSignal(signal)
        );
        return true;
      } catch (error: unknown) {
        if (signal?.aborted) return false;
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
