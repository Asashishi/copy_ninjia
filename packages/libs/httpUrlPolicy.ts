/** HTTPS 出站请求的轻量 URL allowlist；不负责 DNS 解析或响应体读取。 */

export interface AllowedHttpsUrlPolicy {
  allowedOrigins?: readonly string[];
  allowedHostnameSuffixes?: readonly string[];
}

export interface ParseAllowedHttpsUrlParams {
  input: string | URL;
  policy: AllowedHttpsUrlPolicy;
}

function isAllowedHostname(hostname: string, allowedSuffixes: readonly string[]): boolean {
  const normalizedHostname: string = hostname.toLowerCase();
  return allowedSuffixes.some((suffix: string): boolean => {
    const normalizedSuffix: string = suffix.toLowerCase();
    return normalizedHostname === normalizedSuffix || normalizedHostname.endsWith(`.${normalizedSuffix}`);
  });
}

/**
 * 只接受 allowlist 内的 HTTPS URL。origin 规则精确匹配；hostname suffix
 * 规则按 DNS label 边界匹配且拒绝自定义端口，避免 eviltelegram.org 之类
 * 的字符串后缀绕过。
 */
export function parseAllowedHttpsUrl({
  input,
  policy,
}: ParseAllowedHttpsUrlParams): URL | null {
  try {
    const url: URL = new URL(input);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;

    if (policy.allowedOrigins?.includes(url.origin) === true) return url;
    if (
      url.port === "" &&
      policy.allowedHostnameSuffixes !== undefined &&
      isAllowedHostname(url.hostname, policy.allowedHostnameSuffixes)
    ) {
      return url;
    }
    return null;
  } catch (_error: unknown) {
    return null;
  }
}
