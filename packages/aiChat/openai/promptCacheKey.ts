/**
 * OpenAI 稳定前缀指纹：把每轮逐字不变的那一段压成 `prompt_cache_key` 后缀。
 *
 * 键让共享同一段前缀的请求尽量落到同一台机器上，使自动前缀缓存有机会命中。
 * 用 SHA-256 而不是快哈希：指纹撞了会让请求被路由到另一个群的参考记忆所用的
 * 缓存分区，而参考记忆里含有群聊摘要。调用方在工具形态不变时每轮回复只算一次。
 *
 * 纯函数叶子模块：不接触任何缓存。
 */

/**
 * 按顺序把各段拼进摘要。
 *
 * 段与段之间插入 NUL 分隔：被哈希的都是提示词与 JSON 文本，其中不可能出现 NUL，
 * 因此「a + b」和「ab + 空」这类拼接歧义不可能把两段不同的前缀算成同一个指纹。
 * @param parts 已序列化好的前缀各段，顺序即语义，由调用方保证同一形态顺序稳定。
 * @returns 十六进制摘要串。
 */
export function stablePrefixFingerprint(parts: readonly string[]): string {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for (const part of parts) {
    hasher.update("\0");
    hasher.update(part);
  }
  return hasher.digest("hex");
}
