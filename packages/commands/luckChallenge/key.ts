/** 默认运势按用户 ID；带所求事项时追加定长 SHA-256 摘要，避免原文放大缓存和磁盘键。 */
export function luckCacheKey(userId: number, text: string | undefined): string {
  if (!text) return String(userId);
  const digest: string = new Bun.CryptoHasher("sha256")
    .update(text, "utf8")
    .digest("hex");
  return `${userId}:${digest}`;
}
