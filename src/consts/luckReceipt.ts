/** 每日运势的签名回执协议、持久化密钥与最终消息展示常量。 */

/** 默认运势 key 为用户 ID；带所求事项时追加一段 SHA-256 十六进制摘要。 */
export const LUCK_CACHE_KEY_PATTERN: RegExp = /^[1-9]\d{0,15}(?::[a-f0-9]{64})?$/;
/** v1 自描述回执：东京日期、base64url cache key 与完整 HMAC-SHA256。 */
export const LUCK_RECEIPT_PATTERN: RegExp =
  /^luck:v1:(\d{4}-\d{2}-\d{2}):([A-Za-z0-9_-]{1,120})\.([A-Za-z0-9_-]{43})$/;
/** 最终消息中展示的 HMAC-SHA256 十六进制摘要。 */
export const LUCK_RECEIPT_HASH_PATTERN: RegExp = /^[a-f0-9]{64}$/;
/** 自描述回执的协议长度硬上限。 */
export const LUCK_RECEIPT_MAX_LENGTH: number = 192;
export const LUCK_RECEIPT_DISPLAY_PREFIX: string = "防伪标记: ";
/** text_link 实体只用作携带原回执；正文仍只展示定长摘要。 */
export const LUCK_RECEIPT_LINK_PREFIX: string = "https://t.me/#luck-receipt=";

/** receipt-secret.json 的日期与 32 字节 base64url 密钥格式。 */
export const LUCK_DAY_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}$/;
export const LUCK_RECEIPT_SECRET_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;
