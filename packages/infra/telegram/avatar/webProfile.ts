import {
  AVATAR_MAX_DOWNLOAD_BYTES,
  PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES,
  TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES,
} from "../../../consts/telegram";
import { runTelegramCategorizedRequest } from "../outboundGate";
import { readBoundedResponseBytes, readBoundedResponseText, type BoundedResponseResult } from "../../../libs/boundedResponse";
import { parseAllowedHttpsUrl } from "../../../libs/httpUrlPolicy";
import { logger } from "../../logger";
import { avatarFetchSignal } from "./shared";

interface ParsedHtmlTag {
  name: string;
  attributes: ReadonlyMap<string, string>;
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

/** 从 t.me 公开主页下载头像，页面或图片异常时返回 null。 */
export async function fetchAvatarFromWebProfile(username: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const pageSignal: AbortSignal = avatarFetchSignal(signal);
    const pageRes: Response = await runTelegramCategorizedRequest({
      category: "download",
      signal: pageSignal,
      execute: (requestSignal: AbortSignal): Promise<Response> => fetch(`https://telegram.me/${encodeURIComponent(username)}`, {
        redirect: "error",
        signal: requestSignal,
      }),
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

    const imageSignal: AbortSignal = avatarFetchSignal(signal);
    const imgRes: Response = await runTelegramCategorizedRequest({
      category: "download",
      signal: imageSignal,
      execute: (requestSignal: AbortSignal): Promise<Response> => fetch(photoUrl, {
        redirect: "error",
        signal: requestSignal,
      }),
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
