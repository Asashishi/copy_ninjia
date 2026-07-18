import type { StickerConfig } from "../types/stickers";

export type { StickerConfig } from "../types/stickers";

/** 运行时配置的最小结构校验工具。配置文件和环境变量均属于不可信输入。 */

/** 判断未知值是否为可逐字段校验的普通对象。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 要求对象键集合与 schema 完全一致，额外字段也视为配置错误。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys: string[] = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key: string) => Object.hasOwn(value, key));
}

/** 判断未知值是否为只包含非空字符串的数组，并为后续使用保留元素类型。 */
function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string" && item.trim().length > 0);
}

/** Telegram 用户 ID 必须是十进制正安全整数，拒绝指数、小数和隐式空白。 */
export function parseTelegramUserId(raw: string, source: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid Telegram user ID in ${source}: "${raw}" (expected a positive decimal integer)`);
  }
  const id: number = Number(raw);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`Invalid Telegram user ID in ${source}: "${raw}" (outside the safe integer range)`);
  }
  return id;
}

/** 解析逗号分隔的 Telegram 用户 ID；允许整项为空，并对重复 ID 去重。 */
export function parseTelegramUserIdList(raw: string, source: string): readonly number[] {
  if (raw.trim() === "") return Object.freeze([]);
  return Object.freeze([...new Set(raw.split(",").map((part: string) => parseTelegramUserId(part.trim(), source)))]);
}

const STICKER_PACK_NAME_PATTERN: RegExp = /^[A-Za-z0-9_]{1,64}$/;

/** 严格解码 stickers.json，并拒绝非法或重复的贴纸包名。 */
export function parseStickerConfig(value: unknown): StickerConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["packs"]) || !Array.isArray(value.packs)) {
    throw new Error("Invalid stickers config: expected exactly { packs: string[] }");
  }

  const packs: string[] = [];
  const seen: Set<string> = new Set();
  for (const pack of value.packs) {
    if (typeof pack !== "string" || !STICKER_PACK_NAME_PATTERN.test(pack)) {
      throw new Error(`Invalid stickers config pack name: ${JSON.stringify(pack)}`);
    }
    if (seen.has(pack)) {
      throw new Error(`Duplicate stickers config pack name: ${pack}`);
    }
    seen.add(pack);
    packs.push(pack);
  }

  return Object.freeze({ packs: Object.freeze(packs) });
}

/** reactions.json 解码后的只读结构。 */
export interface ReactionConfig {
  readonly emotionKeywords: Readonly<Record<string, readonly string[]>>;
}

/** 严格解码 reactions.json，保证每个反应都只有非空关键词。 */
export function parseReactionConfig(value: unknown): ReactionConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["emotionKeywords"]) || !isPlainRecord(value.emotionKeywords)) {
    throw new Error("Invalid reactions config: expected exactly { emotionKeywords: Record<string, string[]> }");
  }

  const emotionKeywords: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const [emoji, keywords] of Object.entries(value.emotionKeywords)) {
    if (!emoji.trim() || !isNonEmptyStringArray(keywords)) {
      throw new Error(`Invalid reactions config entry for ${JSON.stringify(emoji)}`);
    }
    emotionKeywords[emoji] = Object.freeze([...keywords]);
  }

  return Object.freeze({ emotionKeywords: Object.freeze(emotionKeywords) });
}
