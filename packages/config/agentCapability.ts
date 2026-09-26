/**
 * config/dynamic/agent.json 里单项 AI 能力的严格解码（纯函数，不读盘、不接触缓存）：通用字段
 * provider、api_key、base_url、model，google provider 独有的 headers，image 的
 * image_protocol，以及 tts 的 voice、style 与每日额度两项。文件级加载、分段快照与 holder
 * 在 config/agent.ts。报错只写来源路径、字段路径与期望形态，不回显配置值。
 */

import {
  LOOPBACK_HOSTS,
  EXPECTED_AGENT_HEADER_VALUE,
  EXPECTED_AGENT_HEADERS,
  EXPECTED_BASE_URL,
  AGENT_API_KEY_PLACEHOLDERS,
  AGENT_HEADER_NAME_PATTERN,
  AGENT_HEADER_VALUE_PATTERN,
  AGENT_HEADERS_MAX_ENTRIES,
  AGENT_RESERVED_HEADER_NAMES,
} from "../consts/agent";
import { TTS_DEFAULT_DAILY_LIMIT, TTS_DEFAULT_DAILY_RESERVE_QUOTA } from "../consts/aiChat/voiceMessage";
import { GEMINI_SPEECH_STYLE } from "../consts/aiChat/gemini";
import { invalidInput } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type {
  AgentCapabilityConfig,
  AgentImageCapabilityConfig,
  AgentProvider,
  AgentTtsCapabilityConfig,
  OpenAiImageProtocol,
} from "../types/config";

/** 解码必填非空字符串。 */
function requiredString(value: unknown, context: string, sourcePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidInput(sourcePath, context, "a non-empty string");
  }
  return value.trim();
}

/** 解码必填凭据；示例占位串存在时必须在启动阶段拒绝。 */
function requiredApiKey(value: unknown, context: string, sourcePath: string): string {
  const apiKey: string = requiredString(value, context, sourcePath);
  if (AGENT_API_KEY_PLACEHOLDERS.includes(apiKey)) {
    return invalidInput(sourcePath, context, "a configured non-placeholder string");
  }
  return apiKey;
}

/**
 * 解码可选的绝对端点；缺省交给对应 SDK 的官方地址。
 *
 * 默认只收 HTTPS：这个字段旁边就是同一项能力的 api_key，配成非本机的明文 HTTP
 * 端点等于让密钥每次请求都在网络上裸奔，而校验放行之后没有任何一层会再提醒。
 * 本机三个回环主机是例外——本地代理和测试端点是正当用法，且流量不出机器。
 *
 * userinfo 一律拒绝：`https://user:pass@host` 里的凭据既进不了脱敏名单（脱敏
 * 读的是 api_key 与 headers 的值），又会被 SDK 原样拼进每一次请求 URL，一旦进日志就是
 * 明文。供应商凭据走 api_key，三方网关鉴权走 google provider 的 headers。
 *
 * fragment 一律拒绝：两家 SDK 都把 base_url 当路径前缀拼接，`#` 之后的部分不会
 * 被发到服务端。留着它只会让人以为自己配了一个能生效的端点。
 */
function optionalBaseUrl(value: unknown, context: string, sourcePath: string): string | undefined {
  if (value === undefined) return undefined;
  const raw: string = requiredString(value, context, sourcePath);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidInput(sourcePath, context, EXPECTED_BASE_URL);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
    return invalidInput(sourcePath, context, EXPECTED_BASE_URL);
  }
  if (parsed.protocol === "https:") return raw;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(parsed.hostname)) return raw;
  return invalidInput(sourcePath, context, EXPECTED_BASE_URL);
}

/** 解码 provider；Gemini 是模型家族名，对外协议名统一为 google。 */
function requiredProvider(value: unknown, context: string, sourcePath: string): AgentProvider {
  if (value === "google" || value === "openai") return value;
  return invalidInput(sourcePath, context, '"google" or "openai"');
}

/** 解码 OpenAI 兼容生图协议。 */
function requiredImageProtocol(
  value: unknown,
  context: string,
  sourcePath: string
): OpenAiImageProtocol {
  if (value === "openai" || value === "openai-standard" || value === "xai") return value;
  return invalidInput(sourcePath, context, '"openai", "openai-standard", or "xai"');
}

/**
 * 解码 google provider 的可选 headers：1～AGENT_HEADERS_MAX_ENTRIES 条，名为 HTTP token、
 * 忽略大小写不重复且不在 AGENT_RESERVED_HEADER_NAMES 内；值去掉首尾空白后非空，
 * 只含可打印 ASCII 与空格、制表符。报错只写字段路径与期望形态，不回显请求头值。
 */
function optionalHeaders(
  value: unknown,
  context: string,
  sourcePath: string
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return invalidInput(sourcePath, context, EXPECTED_AGENT_HEADERS);
  const entries: [string, unknown][] = Object.entries(value);
  if (entries.length === 0 || entries.length > AGENT_HEADERS_MAX_ENTRIES) {
    return invalidInput(sourcePath, context, EXPECTED_AGENT_HEADERS);
  }
  const headers: [string, string][] = [];
  const seen: Set<string> = new Set<string>();
  for (const [name, raw] of entries) {
    const lowerName: string = name.toLowerCase();
    if (!AGENT_HEADER_NAME_PATTERN.test(name) || AGENT_RESERVED_HEADER_NAMES.includes(lowerName) || seen.has(lowerName)) {
      return invalidInput(sourcePath, context, EXPECTED_AGENT_HEADERS);
    }
    seen.add(lowerName);
    const fieldContext: string = `${context}.${name}`;
    const headerValue: string = requiredString(raw, fieldContext, sourcePath);
    if (!AGENT_HEADER_VALUE_PATTERN.test(headerValue)) {
      return invalidInput(sourcePath, fieldContext, EXPECTED_AGENT_HEADER_VALUE);
    }
    headers.push([name, headerValue]);
  }
  return Object.fromEntries(headers);
}

/** 某个 provider 下一项能力允许的全部字段：通用字段、google 独有的 headers，再加能力自己的字段。 */
function capabilityKeys(provider: AgentProvider, extraKeys: readonly string[]): readonly string[] {
  const common: readonly string[] = provider === "google"
    ? ["provider", "api_key", "base_url", "headers", "model"]
    : ["provider", "api_key", "base_url", "model"];
  return [...common, ...extraKeys];
}

/** 字段集不符时的期望形态；extraShape 是能力自己的字段，以 `, ` 开头或为空串。 */
function capabilityShape(provider: AgentProvider, extraShape: string): string {
  const headers: string = provider === "google" ? "headers?, " : "";
  return `exactly { provider, api_key, base_url?, ${headers}model${extraShape} } when provider is ${provider}`;
}

/**
 * 解码通用字段；调用方须先按 capabilityKeys 核对过字段集。google 分支另解 headers，
 * openai 分支 headers 恒为 undefined。
 */
function parseCapabilityFields(
  value: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): AgentCapabilityConfig {
  const provider: AgentProvider = requiredProvider(value.provider, `${context}.provider`, sourcePath);
  const apiKey: string = requiredApiKey(value.api_key, `${context}.api_key`, sourcePath);
  const baseUrl: string | undefined = optionalBaseUrl(value.base_url, `${context}.base_url`, sourcePath);
  if (provider === "google") {
    const headers: Readonly<Record<string, string>> | undefined =
      optionalHeaders(value.headers, `${context}.headers`, sourcePath);
    return { provider, apiKey, baseUrl, headers, model: requiredString(value.model, `${context}.model`, sourcePath) };
  }
  return { provider, apiKey, baseUrl, headers: undefined, model: requiredString(value.model, `${context}.model`, sourcePath) };
}

/** 能力值必须是普通对象；字段集由调用方在解出 provider 后按 capabilityKeys 核对。 */
function capabilityRecord(
  value: unknown,
  context: string,
  sourcePath: string
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return invalidInput(sourcePath, context, "an object");
  return value;
}

/** 解码一项普通能力；通用字段之外的拼写错误一律拒绝。 */
export function parseCapability(
  value: unknown,
  context: string,
  sourcePath: string
): AgentCapabilityConfig {
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: AgentProvider = requiredProvider(record.provider, `${context}.provider`, sourcePath);
  if (!hasOnlyKeys(record, capabilityKeys(provider, []))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, ""));
  }
  return parseCapabilityFields(record, context, sourcePath);
}

/** 解码生图能力；只有 OpenAI 协议分支接受并要求 image_protocol。 */
export function parseImageCapability(
  value: unknown,
  sourcePath: string
): AgentImageCapabilityConfig {
  const context: string = "$.agent.image";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: AgentProvider = requiredProvider(record.provider, `${context}.provider`, sourcePath);
  const extraKeys: readonly string[] = provider === "openai" ? ["image_protocol"] : [];
  if (!hasOnlyKeys(record, capabilityKeys(provider, extraKeys))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, provider === "openai" ? ", image_protocol" : ""));
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  if (fields.provider === "google") return { ...fields, imageProtocol: undefined };
  return {
    ...fields,
    imageProtocol: requiredImageProtocol(record.image_protocol, `${context}.image_protocol`, sourcePath),
  };
}

/** optionalQuotaInteger 的参数。 */
interface QuotaIntegerOptions {
  readonly value: unknown;
  readonly context: string;
  readonly sourcePath: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  /** 错误信息里的期望形态，不含配置值。 */
  readonly expected: string;
}

/**
 * 解码语音合成每日额度的一个整数字段：存在时必须是 min～max 的整数；缺省时取 fallback，
 * fallback 落在区间外同样按 expected 拒绝。
 */
function optionalQuotaInteger({ value, context, sourcePath, fallback, min, max, expected }: QuotaIntegerOptions): number {
  if (value === undefined) {
    if (fallback >= min && fallback <= max) return fallback;
    return invalidInput(sourcePath, context, expected);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalidInput(sourcePath, context, expected);
  }
  return value;
}

/**
 * 解码语音合成能力；通用字段之外必填 voice，style 缺省使用 GEMINI_SPEECH_STYLE。
 * 可选 daily_limit 与 daily_reserve_quota。daily_limit 是正整数；
 * daily_reserve_quota 是 0～daily_limit-1 的整数，保证 AI 语音工具至少有 1 次额度。缺省值
 * （TTS_DEFAULT_DAILY_LIMIT、TTS_DEFAULT_DAILY_RESERVE_QUOTA）同样按这一关系核对。
 */
export function parseTtsCapability(
  value: unknown,
  sourcePath: string
): AgentTtsCapabilityConfig {
  const context: string = "$.agent.tts";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: AgentProvider = requiredProvider(record.provider, `${context}.provider`, sourcePath);
  if (!hasOnlyKeys(record, capabilityKeys(provider, ["voice", "style", "daily_limit", "daily_reserve_quota"]))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, ", voice, style?, daily_limit?, daily_reserve_quota?"));
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  const voice: string = requiredString(record.voice, `${context}.voice`, sourcePath);
  const style: string = record.style === undefined
    ? GEMINI_SPEECH_STYLE
    : requiredString(record.style, `${context}.style`, sourcePath);
  const dailyLimit: number = optionalQuotaInteger({
    value: record.daily_limit,
    context: `${context}.daily_limit`,
    sourcePath,
    fallback: TTS_DEFAULT_DAILY_LIMIT,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    expected: "a positive integer",
  });
  const dailyReserveQuota: number = optionalQuotaInteger({
    value: record.daily_reserve_quota,
    context: `${context}.daily_reserve_quota`,
    sourcePath,
    fallback: TTS_DEFAULT_DAILY_RESERVE_QUOTA,
    min: 0,
    max: dailyLimit - 1,
    expected: `an integer from 0 to ${dailyLimit - 1} (daily_limit - 1; defaults to ${TTS_DEFAULT_DAILY_RESERVE_QUOTA} when omitted)`,
  });
  return { ...fields, voice, style, dailyLimit, dailyReserveQuota };
}
