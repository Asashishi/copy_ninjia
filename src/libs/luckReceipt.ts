import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { LuckReceiptSecret } from "../types/diskIO/storage";

const CACHE_KEY_PATTERN: RegExp = /^[1-9]\d{0,15}(?::[a-f0-9]{64})?$/;
const RECEIPT_PATTERN: RegExp = /^luck:v1:(\d{4}-\d{2}-\d{2}):([A-Za-z0-9_-]{1,120})\.([A-Za-z0-9_-]{43})$/;
const RECEIPT_HASH_PATTERN: RegExp = /^[a-f0-9]{64}$/;
export const LUCK_RECEIPT_MAX_LENGTH: number = 192;
export const LUCK_RECEIPT_DISPLAY_PREFIX: string = "防伪标记: ";
export const LUCK_RECEIPT_LINK_PREFIX: string = "https://t.me/#luck-receipt=";

function secretKey(secret: LuckReceiptSecret): Buffer {
  const key: Buffer = Buffer.from(secret.key, "base64url");
  if (secret.version !== 1 || key.length !== 32 || key.toString("base64url") !== secret.key) {
    throw new Error("Invalid in-memory luck receipt secret");
  }
  return key;
}

function encodedCacheKey(cacheKey: string): string {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) throw new Error(`Invalid luck cache key: ${cacheKey}`);
  return Buffer.from(cacheKey, "utf8").toString("base64url");
}

function signature(secret: LuckReceiptSecret, unsignedReceipt: string): Buffer {
  return createHmac("sha256", secretKey(secret)).update(unsignedReceipt, "utf8").digest();
}

/** 自描述签名回执：版本、东京日期、cache key 与完整 HMAC。 */
export function createLuckReceipt(secret: LuckReceiptSecret, cacheKey: string): string {
  const unsigned: string = `luck:v1:${secret.day}:${encodedCacheKey(cacheKey)}`;
  const receipt: string = `${unsigned}.${signature(secret, unsigned).toString("base64url")}`;
  if (receipt.length > LUCK_RECEIPT_MAX_LENGTH) throw new Error("Luck receipt exceeds its protocol length limit");
  return receipt;
}

/** 最终消息只展示完整回执的定长 SHA-256，原回执由 Telegram 实体元数据携带。 */
export function hashLuckReceipt(receipt: string): string {
  return createHash("sha256").update(receipt, "utf8").digest("hex");
}

export function isLuckReceiptHash(value: string): boolean {
  return RECEIPT_HASH_PATTERN.test(value);
}

/**
 * 常量时间验证回执并直接还原 cache key；错误版本、日期、长度、编码或签名
 * 一律返回 undefined，不依赖任何待确认反向索引。
 */
export function verifyLuckReceipt(
  receipt: string,
  expectedDay: string,
  secret: LuckReceiptSecret
): string | undefined {
  if (receipt.length > LUCK_RECEIPT_MAX_LENGTH || secret.day !== expectedDay) return undefined;
  const match: RegExpExecArray | null = RECEIPT_PATTERN.exec(receipt);
  if (match?.[1] !== expectedDay) return undefined;
  const encoded: string = match[2]!;
  const decoded: Buffer = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return undefined;
  const cacheKey: string = decoded.toString("utf8");
  if (!CACHE_KEY_PATTERN.test(cacheKey) || encodedCacheKey(cacheKey) !== encoded) return undefined;

  const signatureOffset: number = receipt.lastIndexOf(".");
  const unsigned: string = receipt.slice(0, signatureOffset);
  const expected: Buffer = signature(secret, unsigned);
  const actual: Buffer = Buffer.from(match[3]!, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  return cacheKey;
}

/** 以日级密钥、日期和 cache key 派生稳定的 256 位抽签熵。 */
export function deriveLuckEntropy(secret: LuckReceiptSecret, cacheKey: string): Buffer {
  encodedCacheKey(cacheKey);
  return createHmac("sha256", secretKey(secret))
    .update("luck-draw:v1\0", "utf8")
    .update(secret.day, "utf8")
    .update("\0", "utf8")
    .update(cacheKey, "utf8")
    .digest();
}

/** 结果消息的可见标签不参与 HMAC；旧版无标签回执仍原样返回以便验证。 */
export function unwrapLuckReceiptLine(line: string): string {
  return line.startsWith(LUCK_RECEIPT_DISPLAY_PREFIX)
    ? line.slice(LUCK_RECEIPT_DISPLAY_PREFIX.length)
    : line;
}

/** AI 记忆只保留用户可读正文，不把内部签名协议混进群聊转录。 */
export function stripLuckReceipt(text: string): string {
  const lastLineBreak: number = text.lastIndexOf("\n");
  if (lastLineBreak < 0) return text;
  const line: string = text.slice(lastLineBreak + 1);
  const receipt: string = unwrapLuckReceiptLine(line);
  const isCurrentHash: boolean = line.startsWith(LUCK_RECEIPT_DISPLAY_PREFIX) && isLuckReceiptHash(receipt);
  const isLegacyReceipt: boolean = receipt.length <= LUCK_RECEIPT_MAX_LENGTH && RECEIPT_PATTERN.test(receipt);
  return isCurrentHash || isLegacyReceipt
    ? text.slice(0, lastLineBreak)
    : text;
}
