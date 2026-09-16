/** 单行文本归一化的空白匹配规则，覆盖 NEL。 */
export const INLINE_WHITESPACE_PATTERN: RegExp = /[\s\u0085]+/g;

/**
 * libs/text.ts 的 sanitizeInline 前置判定：非普通空格的空白（换行、制表等）、NEL、
 * 首空格、尾空格或连续空格任一出现，即说明折叠会改动输入。空白集合与
 * INLINE_WHITESPACE_PATTERN 一致；不带 g/y 标志，test() 不受 lastIndex 影响也不改写它，可重复共享。
 */
export const INLINE_SANITIZE_REQUIRED_PATTERN: RegExp = /[^\S ]|\u0085|^ | $| {2}/;

/** 安全展示文本时需要移除的双向控制字符。 */
export const BIDI_CONTROL_PATTERN: RegExp = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** 用户名规范化时去除的连续前导 @。 */
export const LEADING_AT_SIGNS_PATTERN: RegExp = /^@+/;

/** 代码围栏语言标签不允许包含的空白与反引号。 */
export const FENCE_LANGUAGE_REJECT: RegExp = /[\s`]/;
