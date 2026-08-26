/** 日志参数的线程内严格序列化与凭据脱敏；不负责输出或跨线程传输。 */

import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  telegramConfigCache,
} from "../../cache/perThread/config";
import { loggerSecretsMemo } from "../../cache/perThread/logger";
import { LOGGER_UNSERIALIZABLE_VALUE } from "../../consts/logger";
import { REDACTED_SECRET, redactSecretsInText } from "../../libs/redaction";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  TelegramConfig,
} from "../../types/config";

/**
 * 本次调用要脱敏的敏感值。每条日志取一次而不是每个参数取一次；不提到模块
 * 加载期，是为了不依赖「logger 首次 import 时配置已经读完」这个额外前提。
 * Telegram 与 agent loader 都把成功结果放在线程内 holder，logger 只读取已有
 * 快照，不反向触发同步文件 I/O。
 *
 * 结果按三个 holder 的**对象身份**记忆化（holder 见 cache/perThread/logger.ts 的
 * loggerSecretsMemo）。配置身份没变时凭据集合也不变，因此不逐条日志重建数组。
 */
function currentSecrets(): readonly string[] {
  const telegram: TelegramConfig | null = telegramConfigCache.current;
  const adDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
  const agent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  if (
    loggerSecretsMemo.telegram === telegram &&
    loggerSecretsMemo.adDetect === adDetect &&
    loggerSecretsMemo.agent === agent
  ) return loggerSecretsMemo.value;

  const secrets: string[] = [];
  const telegramToken: string | undefined = telegram?.botToken;
  if (telegramToken !== undefined) secrets.push(telegramToken);
  const adDetectApiKey: string | undefined = adDetect?.apiKey;
  if (adDetectApiKey !== undefined) secrets.push(adDetectApiKey);
  if (agent !== null) {
    secrets.push(agent.text.apiKey, agent.summary.apiKey, agent.media.apiKey);
    if (agent.image !== undefined) secrets.push(agent.image.apiKey);
    if (agent.song !== undefined) secrets.push(agent.song.apiKey);
  }
  loggerSecretsMemo.telegram = telegram;
  loggerSecretsMemo.adDetect = adDetect;
  loggerSecretsMemo.agent = agent;
  loggerSecretsMemo.value = secrets;
  return secrets;
}

/**
 * 把任意日志参数转成可 JSON 序列化的值。Error（含 GrammyError 等子类）
 * 展开为 name/message/stack 加自有可枚举属性；其余对象尝试 JSON 序列化，
 * 失败（循环引用等）则退化为字符串。
 *
 * Bun 的 fetch 网络异常会把完整请求 URL 放进 Error 的可枚举 path 字段；
 * Telegram 文件下载 URL 内嵌 BOT_TOKEN。对象先序列化成稳定 JSON，再对整份
 * 文本做值级脱敏，确保 message/stack/path/cause 任一位置都不会漏。
 */
function serializeArg(arg: unknown, secrets: readonly string[]): unknown {
  // 绝大多数日志参数是拼好的字符串（本项目的 logger.log/info/warn 全部如此）。
  // 字符串直接脱敏即可，不必走 stringify -> 脱敏 -> parse 的往返：两条路径对
  // 字符串的结果逐字符相同，唯一的差异是敏感值自身含 JSON 转义字符时，往返
  // 路径反而会因为转义后不再字面匹配而漏脱敏，直接脱敏没有这个问题。
  if (typeof arg === "string") {
    return redactSecretsInText(redactSensitiveFieldsInText(arg), secrets);
  }

  const error: Error | null = asError(arg);
  const serializable: unknown = error !== null
    ? {
      name: readErrorString(error, "name", "Error"),
      message: readErrorString(error, "message", LOGGER_UNSERIALIZABLE_VALUE),
      stack: readErrorString(error, "stack", undefined),
      ...ownEnumerableProperties(error),
    }
    // 非 Error 不预先做一轮 stringify/parse：下面那一轮的结果与先往返一次
    // 完全相同（safeStringify 的兜底对两条路径同样降级），白付一次全量序列化。
    : arg;

  const redacted: string = redactSecretsInText(safeStringify(serializable), secrets);
  // 脱敏是对整份 JSON 文本做字面替换，敏感值本身是 JSON 结构字符（Telegram
  // token 或 agent api_key 只要 trim 后非空就能通过语法校验，`"` 或 `,` 都是合法取值）
  // 时，替换结果就不再是合法 JSON。裸 parse 会让这个 SyntaxError 从 logger 自己
  // 的调用点抛出去：catch 块里那句 logger.error 顶掉原始错误、真实故障一条都不
  // 落盘，连 uncaughtException 处理器都会在汇报退出原因时再炸一次。解析不了就
  // 退化成脱敏后的文本，日志本身绝不能成为新的故障源。
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}

/** `instanceof` 也可能触发 Proxy trap；失败时交给普通不可序列化对象路径。 */
function asError(value: unknown): Error | null {
  try {
    return value instanceof Error ? value : null;
  } catch {
    return null;
  }
}

/** Error 的核心字段也允许被子类或 Proxy 改成访问器；读取失败只降级该字段。 */
function readErrorString(
  error: Error,
  key: "name" | "message" | "stack",
  fallback: string | undefined
): string | undefined {
  try {
    const value: unknown = error[key];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Error 自有的可枚举属性（GrammyError.payload、Bun fetch 的 code/path 等），
 * 逐个属性独立降级：某个值不可序列化（循环引用、BigInt）时只让它自己退化成
 * 字符串，不会连累整条记录。不能整体 `{...JSON.parse(safeStringify({...arg}))}`
 * ——safeStringify 走 `String(value)` 兜底时返回的是字符串，展开进对象字面量
 * 会炸成 `{"0":"[","1":"o",...}` 一串下标键，把真正要看的 code/path 冲掉。
 *
 * 累加对象必须无原型：键来自 error 自身，`__proto__` 一旦出现在里面，往普通
 * `{}` 上赋值命中的是 Object.prototype 继承来的那个访问器——值是对象就静默换掉
 * 本条记录的原型，不是对象就整句赋值失效。两种结局都一样：那个字段不会出现在
 * logs/ 的错误记录里，运维排查时看不到唯一能解释这次故障的诊断。外层的对象
 * 展开与 JSON.parse 都按数据属性定义，不吃这个亏，只有这里的下标赋值会。
 */
function ownEnumerableProperties(error: Error): Record<string, unknown> {
  const own: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(error);
  } catch {
    return own;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) {
      // 日志不能为了取诊断字段执行依赖对象的 getter；它可能正是原始故障源。
      own[key] = LOGGER_UNSERIALIZABLE_VALUE;
      continue;
    }
    const value: unknown = descriptor.value;
    // JSON 不能表达 undefined；逐个降级时显式跳过，避免凭空生成 null 字段。
    if (value === undefined) continue;
    own[key] = JSON.parse(safeStringify(value));
  }
  return own;
}

/**
 * 判断一个 JSON 字段名是否直接承载凭据。
 *
 * 这里不能只依赖配置值级替换：OpenAI/xAI SDK 的错误对象会附带上游响应头，
 * Cloudflare 的 `set-cookie` 值不是本进程配置的密钥，却同样不能进入 journal 或
 * logs/。精确匹配字段名，不把 `output_tokens`、request id 等正常诊断一并抹掉。
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
 * 才切片并做大小写归一化，避免普通日志里的 URL、时间戳为每个分隔符制造字符串。
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
 * 找到字符串或容器形态字段值的末尾。引号内的逗号与括号不结束扫描，保证
 * `set-cookie` 中的 Expires 日期不会被截断；格式残缺时宁可脱敏到文本结尾。
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
 */
function redactSensitiveFieldsInText(text: string): string {
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
  return redacted === null ? text : redacted + text.slice(copyFrom);
}

/**
 * JSON.stringify 的无状态脱敏 replacer。
 *
 * 除对象字段外，也覆盖二元 header tuple 与 Node 风格扁平 rawHeaders；字符串值
 * 继续检查 SDK 已经预格式化进去的字段。全部复用既有序列化遍历，避免为每条错误
 * 日志深拷贝整棵 SDK 错误对象。函数不闭包捕获本次调用数据，调用 shape 固定，也
 * 没有可增长的敏感字段注册表。
 */
function redactSensitiveLogField(
  this: unknown,
  key: string,
  value: unknown
): unknown {
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
  if (typeof value === "string") {
    const redacted: string = redactSensitiveFieldsInText(value);
    return redacted;
  }
  return value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, redactSensitiveLogField) ?? "null";
  } catch {
    try {
      return JSON.stringify(String(value), redactSensitiveLogField);
    } catch {
      // 最后一层必须是静态文本：再次读取 value 只会让 logger 重演原始异常。
      return JSON.stringify(LOGGER_UNSERIALIZABLE_VALUE);
    }
  }
}

/** 单个参数的任何意外失败都只降级该参数，不能替换调用方正在汇报的异常。 */
function serializeArgSafely(
  arg: unknown,
  secrets: readonly string[]
): unknown {
  try {
    return serializeArg(arg, secrets);
  } catch {
    return LOGGER_UNSERIALIZABLE_VALUE;
  }
}

/** 每次 emit 只读取一次配置快照，并把全部参数变为已脱敏可序列化值。 */
export function serializeLogArgs(args: readonly unknown[]): unknown[] {
  const secrets: readonly string[] = currentSecrets();
  return args.map(
    (arg: unknown): unknown => serializeArgSafely(arg, secrets)
  );
}
