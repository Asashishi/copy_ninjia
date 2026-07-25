/** 日志等诊断文本中的敏感值占位符。 */
export const REDACTED_SECRET: string = "[REDACTED]";

/**
 * 从一段文本中移除所有已知敏感值。使用 split/join 而不是动态正则，避免
 * token 中的特殊字符改变匹配语义；空值不参与替换，防止在每个字符间插入
 * 占位符。
 */
export function redactSecretsInText(text: string, secrets: readonly string[]): string {
  let redacted: string = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join(REDACTED_SECRET);
  }
  return redacted;
}
