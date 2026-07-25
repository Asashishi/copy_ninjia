import { createHmac, timingSafeEqual } from "node:crypto";
import {
  LUCK_CACHE_KEY_PATTERN,
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_HASH_PATTERN,
  LUCK_RECEIPT_MAX_LENGTH,
  LUCK_RECEIPT_PATTERN,
} from "../consts/luckReceipt";
import type { LuckReceiptSecret } from "../types/diskIO/storage";

function secretKey(secret: LuckReceiptSecret): Buffer {
  const key: Buffer = Buffer.from(secret.key, "base64url");
  if (secret.version !== 1 || key.length !== 32 || key.toString("base64url") !== secret.key) {
    throw new Error("Invalid in-memory luck receipt secret");
  }
  return key;
}

function encodedCacheKey(cacheKey: string): string {
  if (!LUCK_CACHE_KEY_PATTERN.test(cacheKey)) throw new Error(`Invalid luck cache key: ${cacheKey}`);
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

/**
 * 最终消息直接展示回执里已有的 HMAC-SHA256（转成十六进制），不再对完整
 * 回执额外做一次 SHA-256；原回执仍由 Telegram 实体元数据携带。
 */
export function luckReceiptHmacHash(receipt: string): string | undefined {
  const match: RegExpExecArray | null = LUCK_RECEIPT_PATTERN.exec(receipt);
  if (!match) return undefined;
  const hmac: Buffer = Buffer.from(match[3]!, "base64url");
  if (hmac.length !== 32 || hmac.toString("base64url") !== match[3]) return undefined;
  return hmac.toString("hex");
}

export function isLuckReceiptHash(value: string): boolean {
  return LUCK_RECEIPT_HASH_PATTERN.test(value);
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
  const match: RegExpExecArray | null = LUCK_RECEIPT_PATTERN.exec(receipt);
  if (match?.[1] !== expectedDay) return undefined;
  const encoded: string = match[2]!;
  const decoded: Buffer = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return undefined;
  const cacheKey: string = decoded.toString("utf8");
  if (!LUCK_CACHE_KEY_PATTERN.test(cacheKey) || encodedCacheKey(cacheKey) !== encoded) return undefined;

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

/**
 * 从结果消息的末行取出展示用 HMAC 摘要；可见标签不参与 HMAC。
 * 只识别当前格式：没有标签前缀、或前缀后不是合法摘要，一律不是回执。
 * @returns 十六进制 HMAC 摘要；该行不是当前格式的回执时返回 undefined。
 */
export function luckReceiptHashFromLine(line: string): string | undefined {
  if (!line.startsWith(LUCK_RECEIPT_DISPLAY_PREFIX)) return undefined;
  const hash: string = line.slice(LUCK_RECEIPT_DISPLAY_PREFIX.length);
  return isLuckReceiptHash(hash) ? hash : undefined;
}

/** AI 记忆只保留用户可读正文，不把内部签名协议混进群聊转录。 */
export function stripLuckReceipt(text: string): string {
  const lastLineBreak: number = text.lastIndexOf("\n");
  if (lastLineBreak < 0) return text;
  return luckReceiptHashFromLine(text.slice(lastLineBreak + 1)) === undefined
    ? text
    : text.slice(0, lastLineBreak);
}
