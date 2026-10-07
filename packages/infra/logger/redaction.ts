/** 日志结构化字段脱敏与独立值的安全 JSON 编码。 */
import { LOGGER_HTTP_URL_PATTERN, LOGGER_UNSERIALIZABLE_VALUE } from "../../consts/logger";
import { REDACTED_SECRET } from "../../consts/redaction";
import { redactSecretsInText, redactUrlForLog } from "../../libs/redaction";
import type { LogRedactionReplacer } from "../../types/logger";

/**
 * 判断一个 JSON 字段名是否直接承载凭据。
 *
 * 不依赖配置值级替换，按字段名精确匹配（大小写不敏感），覆盖 SDK 错误对象附带的
 * 上游响应头（如 `set-cookie`）；`output_tokens`、request id 等诊断字段不匹配。
 */
function isSensitiveLogField(key: string): boolean {
  switch (key.toLowerCase()) {
    case "authorization":
    case "proxy-authorization":
    case "cookie":
    case "set-cookie":
    case "x-api-key":
    case "api-key":
    case "apikey":
    case "api_key":
    case "token":
    case "access-token":
    case "access_token":
    case "accesstoken":
    case "refresh-token":
    case "refresh_token":
    case "refreshtoken":
    case "client-secret":
    case "client_secret":
    case "clientsecret":
    case "password":
    case "passwd":
    case "secret":
      return true;
    default:
      return false;
  }
}

/** JSON/HTTP 字段名允许的 ASCII 字符；只用于向前界定冒号左侧的候选键。 */
function isLogFieldNameCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x2d ||
    code === 0x5f ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/** 跳过 JSON 与常见 HTTP 诊断格式在分隔符两侧使用的 ASCII 空白。 */
function skipLogWhitespace(text: string, start: number): number {
  let index: number = start;
  while (index < text.length) {
    const code: number = text.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    index++;
  }
  return index;
}

/**
 * 判断 `:`/`=` 左侧是否是完整的敏感字段名。先按字符边界筛选长度，只有候选键
 * 才切片并做大小写归一化。
 */
function hasSensitiveLogFieldBefore(text: string, separator: number): boolean {
  let end: number = separator;
  while (end > 0) {
    const code: number = text.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    end--;
  }
  if (end > 0) {
    const quote: number = text.charCodeAt(end - 1);
    if (quote === 0x22 || quote === 0x27) end--;
  }

  let start: number = end;
  while (start > 0 && isLogFieldNameCharacter(text.charCodeAt(start - 1))) start--;
  const length: number = end - start;
  // 当前敏感键最短 token、最长 proxy-authorization；先筛掉绝大多数普通字段。
  if (length < 5 || length > 19) return false;
  return isSensitiveLogField(text.slice(start, end));
}

/**
 * 找到字符串或容器形态字段值的末尾。引号内的逗号与括号不结束扫描；
 * 格式残缺时脱敏到文本结尾。
 */
function findStructuredLogValueEnd(text: string, start: number): number {
  const opening: number = text.charCodeAt(start);
  if (opening === 0x22 || opening === 0x27) {
    let escaped: boolean = false;
    for (let index: number = start + 1; index < text.length; index++) {
      const code: number = text.charCodeAt(index);
      if (escaped) {
        escaped = false;
      } else if (code === 0x5c) {
        escaped = true;
      } else if (code === opening) {
        return index + 1;
      }
    }
    return text.length;
  }

  if (opening !== 0x5b && opening !== 0x7b) {
    let index: number = start;
    while (index < text.length) {
      const code: number = text.charCodeAt(index);
      if (code === 0x0a || code === 0x0d) break;
      index++;
    }
    return index;
  }

  let squareDepth: number = 0;
  let objectDepth: number = 0;
  let quote: number = 0;
  let escaped: boolean = false;
  for (let index: number = start; index < text.length; index++) {
    const code: number = text.charCodeAt(index);
    if (quote !== 0) {
      if (escaped) {
        escaped = false;
      } else if (code === 0x5c) {
        escaped = true;
      } else if (code === quote) {
        quote = 0;
      }
      continue;
    }
    if (code === 0x22 || code === 0x27) {
      quote = code;
    } else if (code === 0x5b) {
      squareDepth++;
    } else if (code === 0x5d) {
      squareDepth--;
    } else if (code === 0x7b) {
      objectDepth++;
    } else if (code === 0x7d) {
      objectDepth--;
    }
    if (squareDepth === 0 && objectDepth === 0) return index + 1;
  }
  return text.length;
}

/**
 * 脱敏已经被 SDK/代理拼进字符串的凭据字段，例如错误 message 内嵌的
 * `{"set-cookie":[...]}`。未命中时原样返回且不建立中间数组；命中后仅构造最终
 * 字符串。结构化对象仍由下方 stringify replacer 处理，两条路径共用字段名判定。
 * 带查询串、fragment 或 userinfo 的 HTTP(S) URL 统一保留 origin 与 pathname。
 */
export function redactSensitiveFieldsInText(text: string): string {
  let searchFrom: number = 0;
  let copyFrom: number = 0;
  let redacted: string | null = null;
  while (searchFrom < text.length) {
    let separator: number = searchFrom;
    while (separator < text.length) {
      const code: number = text.charCodeAt(separator);
      if (code === 0x3a || code === 0x3d) break;
      separator++;
    }
    if (separator >= text.length) break;
    searchFrom = separator + 1;
    if (!hasSensitiveLogFieldBefore(text, separator)) continue;

    const valueStart: number = skipLogWhitespace(text, searchFrom);
    if (valueStart >= text.length) break;
    const valueEnd: number = findStructuredLogValueEnd(text, valueStart);
    const prefix: string = text.slice(copyFrom, valueStart);
    redacted = redacted === null
      ? prefix + REDACTED_SECRET
      : redacted + prefix + REDACTED_SECRET;
    copyFrom = valueEnd;
    searchFrom = valueEnd;
  }
  const sanitized: string = redacted === null ? text : redacted + text.slice(copyFrom);
  return sanitized.includes("://") && (sanitized.includes("?") || sanitized.includes("#") || sanitized.includes("@"))
    ? sanitized.replace(LOGGER_HTTP_URL_PATTERN, redactUrlForLog) : sanitized;
}

/**
 * 为一份只读凭据快照创建 JSON.stringify 遍历回调，由线程缓存复用。
 *
 * 除对象字段外，也覆盖二元 header tuple 与 Node 风格扁平 rawHeaders；字符串值
 * 继续检查 SDK 已经预格式化进去的字段。全部复用既有序列化遍历，不深拷贝错误对象。
 * 已登记凭据在 URL 规范化前按原文替换；回调只捕获
 * 本份快照的名单，不读取后续替换的配置，也不捕获每次 emit 的展开状态。
 */
export function createLogRedactionReplacer(secrets: readonly string[]): LogRedactionReplacer {
  return function redactSensitiveLogField(this: unknown, key: string, value: unknown): unknown {
    if (isSensitiveLogField(key)) return REDACTED_SECRET;
    if (key.length > 0 && Array.isArray(this)) {
      const index: number = Number(key);
      if (Number.isInteger(index) && index > 0 && (index & 1) === 1) {
        const headerKey: unknown = this[index - 1];
        if (typeof headerKey === "string" && isSensitiveLogField(headerKey)) {
          return REDACTED_SECRET;
        }
      }
    }
    return typeof value === "string"
      ? redactSensitiveFieldsInText(redactSecretsInText(value, secrets)) : value;
  };
}

/** 使用本次 emit 的快照回调编码；原值编码失败时仍使用同一回调处理字符串兜底。 */
export function safeStringify(value: unknown, replacer: LogRedactionReplacer): string {
  try {
    return JSON.stringify(value, replacer) ?? "null";
  } catch {
    try {
      return JSON.stringify(String(value), replacer);
    } catch {
      // 最后一层是静态文本，不再读取 value。
      return JSON.stringify(LOGGER_UNSERIALIZABLE_VALUE);
    }
  }
}
