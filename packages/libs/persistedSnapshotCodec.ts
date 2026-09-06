import { AI_MEMORY_NON_SPACE_WHITESPACE_PATTERN, AI_MEMORY_TIME_PATTERN, BUFFERED_REPLY_REFERENCE_KEYS, BUFFERED_MESSAGE_KEYS, AI_MEMORY_SNAPSHOT_KEYS } from "../consts/aiChat/persistence";
import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  MAX_SUMMARY_ROUNDS,
  REPLY_REFERENCE_MAX_CHARS,
} from "../consts/aiChat/memory";
import { invalidInput, parseJsonInput } from "./inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "./record";
import type {
  AiMemorySnapshot,
  BufferedMessage,
} from "../types/aiChat/memory";
import { formatTokyoTime } from "./time";
import type {
  StickerCatalogEntry,
  StickerCatalogSnapshot,
} from "../types/stickers/catalog";

/**
 * AI 记忆与贴纸目录当前持久化 schema 的无状态严格 decoder。
 * Disk I/O 启动恢复和 AI Worker 协议 hydrate 必须共用本模块，避免同一份载荷
 * 在两条线程边界上得到不同的校验结论。
 */

function validateInline(value: unknown, source: string, field: string): asserts value is string {
  if (typeof value !== "string" || AI_MEMORY_NON_SPACE_WHITESPACE_PATTERN.test(value)) {
    invalidInput(source, field, "a single-line string containing only ordinary spaces as whitespace");
  }
}

function validateSpeaker(value: Record<string, unknown>, source: string, field: string): void {
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id === 0) {
    invalidInput(source, `${field}.id`, "a nonzero safe integer");
  }
  if (typeof value.messageId !== "number" || !Number.isSafeInteger(value.messageId) || value.messageId <= 0) {
    invalidInput(source, `${field}.messageId`, "a positive safe integer");
  }
  validateInline(value.firstName, source, `${field}.firstName`);
  validateInline(value.lastName, source, `${field}.lastName`);
  if (value.username !== undefined) validateInline(value.username, source, `${field}.username`);
  if (value.forwardedFrom !== undefined) validateInline(value.forwardedFrom, source, `${field}.forwardedFrom`);
  validateInline(value.text, source, `${field}.text`);
  if (value.text.length === 0) invalidInput(source, `${field}.text`, "a non-empty single-line string");
}

function validateReplyReference(value: unknown, source: string, field: string): void {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, BUFFERED_REPLY_REFERENCE_KEYS)) {
    invalidInput(source, field, "the current buffered reply reference object");
  }
  validateSpeaker(value, source, field);
  if ((value.text as string).length > REPLY_REFERENCE_MAX_CHARS) {
    invalidInput(source, `${field}.text`, `at most ${REPLY_REFERENCE_MAX_CHARS} UTF-16 code units`);
  }
  if (value.quote !== undefined) {
    validateInline(value.quote, source, `${field}.quote`);
    if (value.quote.length > REPLY_REFERENCE_MAX_CHARS) {
      invalidInput(source, `${field}.quote`, `at most ${REPLY_REFERENCE_MAX_CHARS} UTF-16 code units`);
    }
  }
}

function validateBufferedMessage(value: unknown, source: string, field: string): void {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, BUFFERED_MESSAGE_KEYS)) {
    invalidInput(source, field, "the current buffered message object");
  }
  validateSpeaker(value, source, field);
  if (value.replyTo !== undefined) validateReplyReference(value.replyTo, source, `${field}.replyTo`);
  if (typeof value.at !== "string" || !AI_MEMORY_TIME_PATTERN.test(value.at)) {
    invalidInput(source, `${field}.at`, "a valid Tokyo local time in YYYY/MM/DD HH:mm:ss format");
  }
  const timestamp: number = Date.parse(value.at.replaceAll("/", "-").replace(" ", "T") + "+09:00");
  if (!Number.isFinite(timestamp) || formatTokyoTime(timestamp) !== value.at) {
    invalidInput(source, `${field}.at`, "a valid Tokyo local time in YYYY/MM/DD HH:mm:ss format");
  }
}

/** 解码已经解析的当前 version=1 AI 记忆快照；非法输入只报告来源与期望。 */
export function decodeAiMemorySnapshot(
  parsed: unknown,
  source: string
): AiMemorySnapshot {
  if (!isPlainRecord(parsed)) {
    return invalidInput(
      source,
      "$",
      "the current version=1 AI memory schema within configured capacities"
    );
  }
  const raw: Record<string, unknown> = parsed;
  if (
    !hasExactKeys(raw, AI_MEMORY_SNAPSHOT_KEYS) ||
    raw.version !== 1 ||
    !Array.isArray(raw.buffer) ||
    raw.buffer.length > AI_MEMORY_HYDRATE_BUFFER_MAX ||
    !Array.isArray(raw.summaries) ||
    !raw.summaries.every((summary: unknown): summary is string => typeof summary === "string") ||
    raw.summaries.length > MAX_SUMMARY_ROUNDS ||
    (raw.pendingSummary !== null && typeof raw.pendingSummary !== "string") ||
    typeof raw.savedAt !== "number" ||
    !Number.isSafeInteger(raw.savedAt) ||
    raw.savedAt < 0
  ) {
    return invalidInput(
      source,
      "$",
      "the current version=1 AI memory schema within configured capacities"
    );
  }
  for (let index: number = 0; index < raw.buffer.length; index++) {
    validateBufferedMessage(raw.buffer[index], source, `$.buffer[${index}]`);
  }
  const buffer: BufferedMessage[] = raw.buffer as BufferedMessage[];
  const summaries: string[] = raw.summaries;
  const pendingSummary: string | null = raw.pendingSummary;
  const savedAt: number = raw.savedAt;
  return { version: 1, buffer, summaries, pendingSummary, savedAt };
}

/** 解析并严格解码一份协议中的 AI 记忆 JSON 文本。 */
export function parseAiMemorySnapshot(
  content: string,
  source: string
): AiMemorySnapshot {
  return decodeAiMemorySnapshot(parseJsonInput(content, source), source);
}

function isStickerCatalogEntry(value: unknown): value is StickerCatalogEntry {
  return isPlainRecord(value) &&
    hasExactKeys(value, ["emoji", "description"]) &&
    typeof value.emoji === "string" &&
    typeof value.description === "string";
}

/** 解码已经解析的当前 version=1 贴纸目录，并保留 __proto__ 等合法自有键。 */
export function decodeStickerCatalogSnapshot(
  parsed: unknown,
  source: string
): StickerCatalogSnapshot {
  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, ["version", "entries", "summary", "savedAt"]) ||
    parsed.version !== 1 ||
    !isPlainRecord(parsed.entries) ||
    (parsed.summary !== null && typeof parsed.summary !== "string") ||
    typeof parsed.savedAt !== "number" ||
    !Number.isSafeInteger(parsed.savedAt) ||
    parsed.savedAt < 0
  ) {
    return invalidInput(source, "$", "the current version=1 sticker catalog schema");
  }
  const entries: Record<string, StickerCatalogEntry> =
    Object.create(null) as Record<string, StickerCatalogEntry>;
  for (const [fileUniqueId, value] of Object.entries(parsed.entries)) {
    if (!isStickerCatalogEntry(value)) {
      return invalidInput(source, "$.entries.*", "an emoji and description string object");
    }
    entries[fileUniqueId] = value;
  }
  const summary: string | null = parsed.summary;
  const savedAt: number = parsed.savedAt;
  return { version: 1, entries, summary, savedAt };
}

/** 解析并严格解码一份协议中的贴纸目录 JSON 文本。 */
export function parseStickerCatalogSnapshot(
  content: string,
  source: string
): StickerCatalogSnapshot {
  return decodeStickerCatalogSnapshot(parseJsonInput(content, source), source);
}
