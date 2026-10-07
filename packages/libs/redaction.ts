import { REDACTED_SECRET, REDACTED_URL } from "../consts/redaction";

/**
 * 从一段文本中移除所有已知敏感值。按字面量替换，不使用动态正则；空值不参与替换。
 *
 * 先 `includes` 再替换，未命中的常见路径不创建临时数组；命中时用字符串形态的
 * `replaceAll` 做字面量匹配。占位符 `[REDACTED]` 不含 `$`，不触发替换模式转义。
 */
export function redactSecretsInText(text: string, secrets: readonly string[]): string {
  let redacted: string = text;
  for (const secret of secrets) {
    if (secret.length === 0 || !redacted.includes(secret)) continue;
    redacted = redacted.replaceAll(secret, REDACTED_SECRET);
  }
  return redacted;
}

/**
 * 日志地址只保留 origin 与 pathname，移除查询串、fragment 与 userinfo；
 * 非法 URL 返回统一占位符。素材日志标签与统一日志序列化边界均复用本函数。
 */
export function redactUrlForLog(raw: string): string {
  try {
    const url: URL = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch (_error: unknown) {
    return REDACTED_URL;
  }
}
