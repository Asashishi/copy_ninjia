/** 按 Bun 文件流增量计算 SHA-256 十六进制摘要；文件类型、链接与权限校验由调用方负责。 */
export async function fileSha256(path: string): Promise<string> {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
