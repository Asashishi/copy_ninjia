/** 默认运势按用户 ID；带所求事项时追加定长 SHA-256 摘要，键长度与原文长度无关。 */
export function luckCacheKey(userId: number, text: string | undefined): string {
  if (!text) return String(userId);
  const digest: string = new Bun.CryptoHasher("sha256")
    .update(text, "utf8")
    .digest("hex");
  return `${userId}:${digest}`;
}
