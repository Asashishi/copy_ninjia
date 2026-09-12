/** 模型二进制载荷的首个非标准 Base64 字母表字符；包含 padding，且不携带匹配游标。 */
export const BASE64_NON_ALPHABET_PATTERN: RegExp = /[^A-Za-z0-9+/]/u;
