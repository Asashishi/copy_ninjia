import { timingSafeEqual } from "node:crypto";
import {
  LUCK_CACHE_KEY_PATTERN,
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_HASH_PATTERN,
  LUCK_RECEIPT_MAX_LENGTH,
  LUCK_RECEIPT_PATTERN,
} from "../consts/luckReceipt";
import type { LuckReceiptSecret } from "../types/diskIO/storage";

/**
 * cache key 的编解码器提到模块级复用，理由同 libs/time.ts 里几个
 * Intl.DateTimeFormat：构造远贵于一次调用，而这两个类在 Bun 上恒可用、构造
 * 不会失败，因此不需要 libs/text.ts 那种可重试的 holder。
 *
 * 解码器带 `fatal: true`：非法 UTF-8 必须抛出而不是替换成 U+FFFD，否则伪造的
 * cache key 会被悄悄改写成另一个合法字符串。抛出后实例仍可继续使用——每次
 * `decode()` 都是独立的非流式调用，不留跨调用状态。
 */
const CACHE_KEY_ENCODER: TextEncoder = new TextEncoder();
const CACHE_KEY_DECODER: TextDecoder = new TextDecoder("utf-8", { fatal: true });

function secretKey(secret: LuckReceiptSecret): Uint8Array {
  const key: Uint8Array = Uint8Array.fromBase64(secret.key, { alphabet: "base64url" });
  if (
    secret.version !== 1 ||
    key.length !== 32 ||
    key.toBase64({ alphabet: "base64url", omitPadding: true }) !== secret.key
  ) {
    throw new Error("Invalid in-memory luck receipt secret");
  }
  return key;
}

/**
 * 解码 base64url，解不开时返回 undefined。
 *
 * 回执正文来自群消息实体，字符集与长度只受 LUCK_RECEIPT_PATTERN 约束，而
 * `Uint8Array.fromBase64` 对长度 ≡ 1 (mod 4) 的输入抛 SyntaxError。校验路径
 * 一律把「解不开」当成普通的格式不合法：异常逸出到 update handler 会被
 * bot.catch 重抛，acknowledged runner 随即带着未确认的 offset 退出，同一条
 * 消息重投后进程再也出不来（见 app/registerHandlers.ts 的 bot.catch）。
 *
 * 只服务校验路径。部署密钥的解码仍留在 secretKey 里按致命错误处理。
 */
function decodeBase64UrlOrUndefined(value: string): Uint8Array | undefined {
  try {
    return Uint8Array.fromBase64(value, { alphabet: "base64url" });
  } catch (error: unknown) {
    void error;
    return undefined;
  }
}

/**
 * cache key 不是本协议认得的形态时按致命错误抛出。
 *
 * 只用在 key 由本进程自己给出的路径（签发与抽签派生）。校验路径不得调用它：
 * 那里的 key 是从群消息里的回执解码出来的，异常会一路逸出到 update handler
 * （见 decodeBase64UrlOrUndefined 的头注）。
 */
function assertValidCacheKey(cacheKey: string): void {
  if (!LUCK_CACHE_KEY_PATTERN.test(cacheKey)) throw new Error(`Invalid luck cache key: ${cacheKey}`);
}

/** 把已经校验过的 cache key 编成无 padding base64url；不自带校验。 */
function encodeCacheKey(cacheKey: string): string {
  return CACHE_KEY_ENCODER.encode(cacheKey).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
}

function signature(secret: LuckReceiptSecret, unsignedReceipt: string): Uint8Array {
  return new Bun.CryptoHasher("sha256", secretKey(secret))
    .update(unsignedReceipt, "utf8")
    .digest();
}

/** 自描述签名回执：版本、东京日期、cache key 与完整 HMAC。 */
export function createLuckReceipt(secret: LuckReceiptSecret, cacheKey: string): string {
  assertValidCacheKey(cacheKey);
  const unsigned: string = `luck:v1:${secret.day}:${encodeCacheKey(cacheKey)}`;
  const encodedSignature: string = signature(secret, unsigned).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
  const receipt: string = `${unsigned}.${encodedSignature}`;
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
  const hmac: Uint8Array | undefined = decodeBase64UrlOrUndefined(match[3]!);
  if (
    hmac?.length !== 32 ||
    hmac.toBase64({ alphabet: "base64url", omitPadding: true }) !== match[3]
  ) return undefined;
  return hmac.toHex();
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
  const decoded: Uint8Array | undefined = decodeBase64UrlOrUndefined(encoded);
  if (decoded?.toBase64({ alphabet: "base64url", omitPadding: true }) !== encoded) return undefined;
  let cacheKey: string;
  try {
    cacheKey = CACHE_KEY_DECODER.decode(decoded);
  } catch (error: unknown) {
    void error;
    return undefined;
  }
  // 外层 test 必须留着：它是 encodeCacheKey 只拿到合法 key 的保证，也顺带把
  // 「解得开但不是本协议 key」挡在编码之前。
  if (!LUCK_CACHE_KEY_PATTERN.test(cacheKey) || encodeCacheKey(cacheKey) !== encoded) return undefined;

  const signatureOffset: number = receipt.lastIndexOf(".");
  const unsigned: string = receipt.slice(0, signatureOffset);
  const expected: Uint8Array = signature(secret, unsigned);
  const actual: Uint8Array | undefined = decodeBase64UrlOrUndefined(match[3]!);
  if (
    actual?.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) return undefined;
  return cacheKey;
}

/** 以日级密钥、日期和 cache key 派生稳定的 256 位抽签熵。 */
export function deriveLuckEntropy(secret: LuckReceiptSecret, cacheKey: string): Uint8Array {
  assertValidCacheKey(cacheKey);
  return new Bun.CryptoHasher("sha256", secretKey(secret))
    .update("luck-draw:v1\0", "utf8")
    .update(secret.day, "utf8")
    .update("\0", "utf8")
    .update(cacheKey, "utf8")
    .digest();
}

/**
 * 从结果消息的末行取出展示用 HMAC 摘要；可见标签不参与 HMAC。
 * 只识别当前格式：没有标签前缀、或前缀后不是合法摘要，一律不是回执。
 *
 * 取的是 `text` 从 `lastLineStart` 到**结尾**的那一段，因此该偏移必须是最后一行
 * 的起点（末个换行符的下一位，或整串没有换行时的 0）。判定按偏移在原串上比
 * 前缀，不先把末行切出来：`confirmLuckDraw` 跑在每一条带换行的 update 上
 * （见 app/registerHandlers.ts 的第二道 middleware），而绝大多数末行都不是回执，
 * 先切子串等于为每条多行消息白付一次子串分配。
 *
 * @param text 完整消息正文。
 * @param lastLineStart 末行在 `text` 中的起始下标。
 * @returns 十六进制 HMAC 摘要；该行不是当前格式的回执时返回 undefined。
 */
export function luckReceiptHashFromLine(
  text: string,
  lastLineStart: number
): string | undefined {
  if (!text.startsWith(LUCK_RECEIPT_DISPLAY_PREFIX, lastLineStart)) return undefined;
  const hash: string = text.slice(lastLineStart + LUCK_RECEIPT_DISPLAY_PREFIX.length);
  return isLuckReceiptHash(hash) ? hash : undefined;
}

/** AI 记忆只保留用户可读正文，不把内部签名协议混进群聊转录。 */
export function stripLuckReceipt(text: string): string {
  const lastLineBreak: number = text.lastIndexOf("\n");
  if (lastLineBreak < 0) return text;
  return luckReceiptHashFromLine(text, lastLineBreak + 1) === undefined
    ? text
    : text.slice(0, lastLineBreak);
}
