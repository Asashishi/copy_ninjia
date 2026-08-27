import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  MAX_SUMMARY_ROUNDS,
} from "../consts/aiChat/memory";
import { invalidInput, parseJsonInput } from "./inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "./record";
import type {
  AiMemorySnapshot,
  BufferedMessage,
  BufferedReplyReference,
} from "../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../types/aiChat/speaker";
import type {
  StickerCatalogEntry,
  StickerCatalogSnapshot,
} from "../types/stickers/catalog";

/**
 * AI 记忆与贴纸目录当前持久化 schema 的无状态严格 decoder。
 * Disk I/O 启动恢复和 AI Worker 协议 hydrate 必须共用本模块，避免同一份载荷
 * 在两条线程边界上得到不同的校验结论。
 */

function isAiSpeakerSnapshot(
  value: unknown
): value is Record<string, unknown> & AiSpeakerSnapshot {
  return isPlainRecord(value) &&
    typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id !== 0 &&
    typeof value.firstName === "string" &&
    typeof value.lastName === "string" &&
    (value.username === undefined || typeof value.username === "string");
}

/**
 * 落盘的被回复引用允许出现的全部键（AI 记忆快照格式的一部分，本模块解码用）。
 *
 * 三张键名表都提到模块级：解码要对滚动缓存里的**每一条**记录各调一次，写在
 * 函数体里就是每条记录新建一个数组；内容是落盘格式本身，不随调用变化。
 * 校验函数只读不改这些数组（见 libs/record.ts）。
 */
const BUFFERED_REPLY_REFERENCE_KEYS: readonly string[] = [
  "id",
  "firstName",
  "lastName",
  "username",
  "messageId",
  "text",
  "quote",
  "forwardedFrom",
];

/** 落盘的滚动缓存单条消息允许出现的全部键；理由同上。 */
const BUFFERED_MESSAGE_KEYS: readonly string[] = [
  "id",
  "firstName",
  "lastName",
  "username",
  "messageId",
  "text",
  "replyTo",
  "forwardedFrom",
  "at",
];

/** version=1 AI 记忆快照顶层必须**恰好**具备的键；理由同上。 */
const AI_MEMORY_SNAPSHOT_KEYS: readonly string[] = [
  "version",
  "buffer",
  "summaries",
  "pendingSummary",
  "savedAt",
];

function isBufferedReplyReference(value: unknown): value is BufferedReplyReference {
  return isAiSpeakerSnapshot(value) &&
    hasOnlyKeys(value, BUFFERED_REPLY_REFERENCE_KEYS) &&
    typeof value.messageId === "number" &&
    Number.isSafeInteger(value.messageId) &&
    value.messageId > 0 &&
    typeof value.text === "string" &&
    (value.quote === undefined || typeof value.quote === "string") &&
    (value.forwardedFrom === undefined || typeof value.forwardedFrom === "string");
}

function isBufferedMessage(value: unknown): value is BufferedMessage {
  return isAiSpeakerSnapshot(value) &&
    hasOnlyKeys(value, BUFFERED_MESSAGE_KEYS) &&
    typeof value.messageId === "number" &&
    Number.isSafeInteger(value.messageId) &&
    value.messageId > 0 &&
    typeof value.text === "string" &&
    (value.replyTo === undefined || isBufferedReplyReference(value.replyTo)) &&
    (value.forwardedFrom === undefined || typeof value.forwardedFrom === "string") &&
    typeof value.at === "string";
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
    !raw.buffer.every(isBufferedMessage) ||
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
  const buffer: BufferedMessage[] = raw.buffer;
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
