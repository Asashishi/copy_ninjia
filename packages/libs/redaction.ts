/** 日志等诊断文本中的敏感值占位符。 */
export const REDACTED_SECRET: string = "[REDACTED]";

/**
 * 从一段文本中移除所有已知敏感值。用字面量替换而不是动态正则，避免 token 里的
 * 特殊字符改变匹配语义；空值不参与替换，防止在每个字符间插入占位符。
 *
 * 先 `includes` 再替换，未命中的常见路径不创建临时数组；命中时用字符串形态的
 * `replaceAll` 做字面量匹配。占位符 `[REDACTED]` 不含 `$`，不会触发替换模式转义。
 */
export function redactSecretsInText(text: string, secrets: readonly string[]): string {
  let redacted: string = text;
  for (const secret of secrets) {
    if (secret.length === 0 || !redacted.includes(secret)) continue;
    redacted = redacted.replaceAll(secret, REDACTED_SECRET);
  }
  return redacted;
}

/** 地址无法解析成 URL 时日志里代替原串的占位符：原串同样可能带着密钥，不能原样打出去。 */
export const REDACTED_URL: string = "[unparsable URL]";

/**
 * 把一个地址收敛成能安全写进 `logs/` 的形态：只留 origin 与 pathname，丢掉查询串、
 * fragment 与 userinfo。
 *
 * 用在部署方**自己配的**地址上（典型是 `state.global.assets` 的素材直链）。这类日志
 * 的诊断价值全在「是哪个地址」——是 `state.json` 里写的那个，还是随版本发布的兜底
 * 常量，看主机名和路径就够了；而查询串里可能是预签名参数（S3/OSS 的
 * `X-Amz-Signature` 之类）。`logs/<day>.json` 的 mode 是 0644 且属于备份对象，
 * 上面的 redactSecretsInText 又只脱敏已登记的 env 密钥、不看 query，所以要在拼接
 * 日志正文时就地做掉。
 */
export function redactUrlForLog(raw: string): string {
  try {
    const url: URL = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch (_error: unknown) {
    return REDACTED_URL;
  }
}
