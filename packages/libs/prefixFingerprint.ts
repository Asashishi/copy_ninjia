/**
 * 稳定前缀指纹：把逐字不变的若干段提示词压成一个固定长度的摘要串。
 *
 * 调用方：OpenAI 回复会话的 `prompt_cache_key` 后缀（aiChat/openai/replySession.ts），
 * 以及 Gemini 共用显式缓存的分槽与内容键（aiChat/gemini/contextCache.ts）。用 SHA-256：
 * 指纹一旦撞车，前者会把请求路由到另一个群参考记忆所在的缓存分区，后者会让一段提示词
 * 引用另一段内容的显式缓存。
 *
 * 纯函数叶子模块：不接触任何缓存。
 */

/**
 * 按顺序把各段拼进摘要。
 *
 * 段与段之间插入 NUL 分隔：被哈希的都是提示词与 JSON 文本，其中不可能出现 NUL，
 * 因此「a + b」和「ab + 空」这类拼接歧义不可能把两段不同的前缀算成同一个指纹。
 * @param parts 已序列化好的前缀各段，顺序即语义，由调用方保证同一形态顺序稳定。
 * @returns base64url 摘要串，固定 43 字符。
 */
export function stablePrefixFingerprint(parts: readonly string[]): string {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for (const part of parts) {
    hasher.update("\0");
    hasher.update(part);
  }
  return hasher.digest("base64url");
}
