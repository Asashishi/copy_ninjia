/**
 * config/dynamic/agent.json 里单项 AI 能力的严格解码（纯函数，不读盘、不接触缓存）：通用字段
 * provider、api_key、base_url、model（provider 为 google、openai 或 anthropic；anthropic 不支持
 * image 与 tts，那两项拒绝它），google 与 anthropic provider 可选的 headers，anthropic provider
 * 可选的 fallback_model，image 的 image_protocol、tts 的 speech_protocol、voice、style、language、
 * bot_language 与每日额度字段，以及 web_search 的 max_calls_per_use。
 * 文件级加载、分段快照与 holder 在 config/agent.ts。报错只写来源路径、字段路径与期望形态，
 * 不回显配置值。
 */

import {
  LOOPBACK_HOSTS,
  EXPECTED_AGENT_FALLBACK_MODEL,
  EXPECTED_AGENT_HEADER_VALUE,
  EXPECTED_AGENT_HEADERS,
  EXPECTED_BASE_URL,
  AGENT_API_KEY_PLACEHOLDERS,
  AGENT_CREDENTIAL_HEADER_NAMES,
  AGENT_HEADER_NAME_PATTERN,
  AGENT_HEADER_VALUE_PATTERN,
  AGENT_HEADERS_MAX_ENTRIES,
  WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE,
  isAgentProvider,
} from "../consts/agent";
import {
  EXPECTED_TTS_BOT_LANGUAGE,
  TTS_DEFAULT_BOT_LANGUAGE,
  TTS_DEFAULT_DAILY_LIMIT,
  TTS_DEFAULT_DAILY_RESERVE_QUOTA,
  TTS_DEFAULT_STYLE,
  isTtsBotLanguage,
} from "../consts/aiChat/voiceMessage";
import { XAI_SPEECH_DEFAULT_LANGUAGE } from "../consts/aiChat/openai";
import { invalidInput } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type {
  AgentCapabilityConfig,
  AgentHeadersProvider,
  AgentImageCapabilityConfig,
  AgentProvider,
  AgentTtsCapabilityConfig,
  AgentWebSearchCapabilityConfig,
  OpenAiImageProtocol,
  OpenAiSpeechProtocol,
  TtsBotLanguage,
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
 * 只接受 HTTPS；LOOPBACK_HOSTS 内的本机主机可用明文 HTTP。
 *
 * userinfo 一律拒绝：供应商凭据走 api_key，三方网关鉴权走 google 或 anthropic provider 的 headers。
 *
 * fragment 一律拒绝：SDK 把 base_url 当路径前缀拼接，`#` 之后的部分不会被发到服务端。
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
  const provider: string = typeof value === "string" ? value.trim() : "";
  if (isAgentProvider(provider)) return provider;
  return invalidInput(sourcePath, context, '"google", "openai" or "anthropic"');
}

/** 解码生图与语音合成的 provider：这两项只有 google 与 openai 的实现，anthropic 一律拒绝。 */
function requiredMediaProvider(value: unknown, context: string, sourcePath: string): "google" | "openai" {
  const provider: string = typeof value === "string" ? value.trim() : "";
  if (provider === "google" || provider === "openai") return provider;
  return invalidInput(sourcePath, context, '"google" or "openai"');
}

/** 解码 OpenAI 兼容生图协议。 */
function requiredImageProtocol(
  value: unknown,
  context: string,
  sourcePath: string
): OpenAiImageProtocol {
  const protocol: string = typeof value === "string" ? value.trim() : "";
  if (protocol === "openai" || protocol === "openai-standard" || protocol === "xai") return protocol;
  return invalidInput(sourcePath, context, '"openai", "openai-standard", or "xai"');
}

/** 解码 OpenAI 协议下的语音合成线协议。 */
function requiredSpeechProtocol(
  value: unknown,
  context: string,
  sourcePath: string
): OpenAiSpeechProtocol {
  const protocol: string = typeof value === "string" ? value.trim() : "";
  if (protocol === "openai" || protocol === "xai") return protocol;
  return invalidInput(sourcePath, context, '"openai" or "xai"');
}

/** optionalHeaders 的参数。 */
interface OptionalHeadersOptions {
  readonly value: unknown;
  readonly context: string;
  readonly sourcePath: string;
  /** 决定禁用的凭据头名与报错期望形态。 */
  readonly provider: AgentHeadersProvider;
}

/**
 * 解码 google 或 anthropic provider 的可选 headers：1～AGENT_HEADERS_MAX_ENTRIES 条，名为 HTTP token、
 * 忽略大小写不重复且不是该 provider 的 AGENT_CREDENTIAL_HEADER_NAMES；值去掉首尾空白后非空，
 * 只含可打印 ASCII 与空格、制表符。报错只写字段路径与期望形态，不回显请求头值。
 */
function optionalHeaders({
  value,
  context,
  sourcePath,
  provider,
}: OptionalHeadersOptions): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const credentialHeader: string = AGENT_CREDENTIAL_HEADER_NAMES[provider];
  const expected: string = EXPECTED_AGENT_HEADERS[provider];
  if (!isPlainRecord(value)) return invalidInput(sourcePath, context, expected);
  const entries: [string, unknown][] = Object.entries(value);
  if (entries.length === 0 || entries.length > AGENT_HEADERS_MAX_ENTRIES) {
    return invalidInput(sourcePath, context, expected);
  }
  const headers: [string, string][] = [];
  const seen: Set<string> = new Set<string>();
  for (const [name, raw] of entries) {
    const lowerName: string = name.toLowerCase();
    if (!AGENT_HEADER_NAME_PATTERN.test(name) || lowerName === credentialHeader || seen.has(lowerName)) {
      return invalidInput(sourcePath, context, expected);
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

/**
 * 某个 provider 下一项能力允许的全部字段：通用字段、google 与 anthropic 的 headers、anthropic 的
 * fallback_model，再加能力自己的字段。
 */
function capabilityKeys(provider: AgentProvider, extraKeys: readonly string[]): readonly string[] {
  if (provider === "openai") return ["provider", "api_key", "base_url", "model", ...extraKeys];
  if (provider === "google") return ["provider", "api_key", "base_url", "headers", "model", ...extraKeys];
  return ["provider", "api_key", "base_url", "headers", "model", "fallback_model", ...extraKeys];
}

/** 字段集不符时的期望形态；extraShape 是能力自己的字段，以 `, ` 开头或为空串。 */
function capabilityShape(provider: AgentProvider, extraShape: string): string {
  const headers: string = provider === "openai" ? "" : "headers?, ";
  const fallbackModel: string = provider === "anthropic" ? ", fallback_model?" : "";
  return `exactly { provider, api_key, base_url?, ${headers}model${fallbackModel}${extraShape} } when provider is ${provider}`;
}

/** optionalFallbackModel 的参数。 */
interface OptionalFallbackModelOptions {
  readonly value: unknown;
  /** 同一能力已解出的 model。 */
  readonly model: string;
  readonly context: string;
  readonly sourcePath: string;
}

/** 解码 anthropic provider 可选的 fallback_model：存在时去掉首尾空白后非空，且与 model 不同。 */
function optionalFallbackModel({ value, model, context, sourcePath }: OptionalFallbackModelOptions): string | undefined {
  if (value === undefined) return undefined;
  const fallbackModel: string = typeof value === "string" ? value.trim() : "";
  if (fallbackModel.length === 0 || fallbackModel === model) {
    return invalidInput(sourcePath, context, EXPECTED_AGENT_FALLBACK_MODEL);
  }
  return fallbackModel;
}

/**
 * 解码通用字段；调用方须先按 capabilityKeys 核对过字段集。google 与 anthropic 分支另解 headers，
 * openai 分支 headers 恒为 undefined；anthropic 分支另解 fallback_model。
 */
function parseCapabilityFields(
  value: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): AgentCapabilityConfig {
  const provider: AgentProvider = requiredProvider(value.provider, `${context}.provider`, sourcePath);
  const apiKey: string = requiredApiKey(value.api_key, `${context}.api_key`, sourcePath);
  const baseUrl: string | undefined = optionalBaseUrl(value.base_url, `${context}.base_url`, sourcePath);
  const model: string = requiredString(value.model, `${context}.model`, sourcePath);
  if (provider === "openai") return { provider, apiKey, baseUrl, headers: undefined, model };
  const headers: Readonly<Record<string, string>> | undefined =
    optionalHeaders({ value: value.headers, context: `${context}.headers`, sourcePath, provider });
  if (provider === "google") return { provider, apiKey, baseUrl, headers, model };
  const fallbackModel: string | undefined =
    optionalFallbackModel({ value: value.fallback_model, model, context: `${context}.fallback_model`, sourcePath });
  return { provider, apiKey, baseUrl, headers, model, fallbackModel };
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

/** 解码独立联网检索能力；max_calls_per_use 缺省补齐，存在时必须是正安全整数。 */
export function parseWebSearchCapability(value: unknown, sourcePath: string): AgentWebSearchCapabilityConfig {
  const context: string = "$.agent.web_search";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: AgentProvider = requiredProvider(record.provider, `${context}.provider`, sourcePath);
  if (!hasOnlyKeys(record, capabilityKeys(provider, ["max_calls_per_use"]))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, ", max_calls_per_use?"));
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  const maxCallsPerUse: number = optionalQuotaInteger({
    value: record.max_calls_per_use,
    context: `${context}.max_calls_per_use`,
    sourcePath,
    fallback: WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    expected: "a positive safe integer",
  });
  return { ...fields, maxCallsPerUse };
}

/** 解码生图能力；只有 OpenAI 协议分支接受并要求 image_protocol，anthropic 不受理。 */
export function parseImageCapability(
  value: unknown,
  sourcePath: string
): AgentImageCapabilityConfig {
  const context: string = "$.agent.image";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: "google" | "openai" = requiredMediaProvider(record.provider, `${context}.provider`, sourcePath);
  const extraKeys: readonly string[] = provider === "openai" ? ["image_protocol"] : [];
  if (!hasOnlyKeys(record, capabilityKeys(provider, extraKeys))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, provider === "openai" ? ", image_protocol" : ""));
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  if (fields.provider === "google") return { ...fields, imageProtocol: undefined };
  if (fields.provider === "anthropic") return invalidInput(sourcePath, `${context}.provider`, '"google" or "openai"');
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
 * 解码语音每日额度或检索调用上限的整数字段：存在时必须是 min～max 的安全整数；缺省时取 fallback，
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

/** 解码可选的 bot_language：缺省为 TTS_DEFAULT_BOT_LANGUAGE；存在时去掉首尾空白后必须是 TTS_BOT_LANGUAGES 之一。 */
function optionalBotLanguage(value: unknown, context: string, sourcePath: string): TtsBotLanguage {
  if (value === undefined) return TTS_DEFAULT_BOT_LANGUAGE;
  const language: string = typeof value === "string" ? value.trim() : "";
  if (isTtsBotLanguage(language)) return language;
  return invalidInput(sourcePath, context, EXPECTED_TTS_BOT_LANGUAGE);
}

/** 语音合成每日额度的两个解码结果。 */
interface TtsDailyQuota {
  readonly dailyLimit: number;
  readonly dailyReserveQuota: number;
}

/**
 * 解码可选的 daily_limit 与 daily_reserve_quota。daily_limit 是正整数；daily_reserve_quota 是
 * 0～daily_limit-1 的整数，使 AI 语音工具至少保留一次额度。缺省值（TTS_DEFAULT_DAILY_LIMIT、
 * TTS_DEFAULT_DAILY_RESERVE_QUOTA）同样按这一关系核对。
 */
function parseTtsDailyQuota(
  record: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): TtsDailyQuota {
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
  return { dailyLimit, dailyReserveQuota };
}

/**
 * 解码 xai 语音协议（`POST /tts`）的配置：端点没有模型名与风格指令，model 与 style 出现即
 * 拒绝；language 是随请求发送的合成语言，缺省为 XAI_SPEECH_DEFAULT_LANGUAGE，与只决定提示词的
 * bot_language 各自独立。调用方已解出 provider 与 speech_protocol。
 */
function parseXAiTtsCapability(
  record: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): AgentTtsCapabilityConfig {
  const keys: readonly string[] = [
    "provider", "api_key", "base_url", "speech_protocol", "voice", "language", "bot_language", "daily_limit",
    "daily_reserve_quota",
  ];
  if (!hasOnlyKeys(record, keys)) {
    return invalidInput(
      sourcePath,
      context,
      "exactly { provider, api_key, base_url?, speech_protocol, voice, language?, bot_language?, daily_limit?, " +
      "daily_reserve_quota? } when provider is openai and speech_protocol is xai"
    );
  }
  const apiKey: string = requiredApiKey(record.api_key, `${context}.api_key`, sourcePath);
  const baseUrl: string | undefined = optionalBaseUrl(record.base_url, `${context}.base_url`, sourcePath);
  const voice: string = requiredString(record.voice, `${context}.voice`, sourcePath);
  const language: string = record.language === undefined
    ? XAI_SPEECH_DEFAULT_LANGUAGE
    : requiredString(record.language, `${context}.language`, sourcePath);
  const botLanguage: TtsBotLanguage = optionalBotLanguage(record.bot_language, `${context}.bot_language`, sourcePath);
  const quota: TtsDailyQuota = parseTtsDailyQuota(record, context, sourcePath);
  return {
    provider: "openai",
    apiKey,
    baseUrl,
    headers: undefined,
    model: undefined,
    speechProtocol: "xai",
    voice,
    style: undefined,
    language,
    botLanguage,
    dailyLimit: quota.dailyLimit,
    dailyReserveQuota: quota.dailyReserveQuota,
  };
}

/**
 * 解码语音合成能力，字段集随协议而定：
 *
 * - google：通用字段（含 headers）之外必填 voice，可选 style。
 * - openai：必填 speech_protocol。取 `openai`（audio/speech）时字段同 google 但无 headers；
 *   取 `xai` 时见 parseXAiTtsCapability。
 *
 * style 缺省使用 TTS_DEFAULT_STYLE；各协议都接受可选的 bot_language（见 optionalBotLanguage）
 * 与 daily_limit、daily_reserve_quota（见 parseTtsDailyQuota）。字段集之外的键一律拒绝；
 * anthropic 不受理。
 */
export function parseTtsCapability(
  value: unknown,
  sourcePath: string
): AgentTtsCapabilityConfig {
  const context: string = "$.agent.tts";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: "google" | "openai" = requiredMediaProvider(record.provider, `${context}.provider`, sourcePath);
  if (provider === "openai") {
    const speechProtocol: OpenAiSpeechProtocol =
      requiredSpeechProtocol(record.speech_protocol, `${context}.speech_protocol`, sourcePath);
    if (speechProtocol === "xai") return parseXAiTtsCapability(record, context, sourcePath);
    if (!hasOnlyKeys(
      record,
      capabilityKeys(provider, ["speech_protocol", "voice", "style", "bot_language", "daily_limit", "daily_reserve_quota"])
    )) {
      return invalidInput(
        sourcePath,
        context,
        "exactly { provider, api_key, base_url?, model, speech_protocol, voice, style?, bot_language?, daily_limit?, " +
        "daily_reserve_quota? } when provider is openai and speech_protocol is openai"
      );
    }
  } else if (!hasOnlyKeys(record, capabilityKeys(provider, ["voice", "style", "bot_language", "daily_limit", "daily_reserve_quota"]))) {
    return invalidInput(
      sourcePath,
      context,
      capabilityShape(provider, ", voice, style?, bot_language?, daily_limit?, daily_reserve_quota?")
    );
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  const voice: string = requiredString(record.voice, `${context}.voice`, sourcePath);
  const style: string = record.style === undefined
    ? TTS_DEFAULT_STYLE
    : requiredString(record.style, `${context}.style`, sourcePath);
  const botLanguage: TtsBotLanguage = optionalBotLanguage(record.bot_language, `${context}.bot_language`, sourcePath);
  const quota: TtsDailyQuota = parseTtsDailyQuota(record, context, sourcePath);
  if (fields.provider === "google") {
    return {
      provider: "google",
      apiKey: fields.apiKey,
      baseUrl: fields.baseUrl,
      headers: fields.headers,
      model: fields.model,
      speechProtocol: undefined,
      voice,
      style,
      language: undefined,
      botLanguage,
      dailyLimit: quota.dailyLimit,
      dailyReserveQuota: quota.dailyReserveQuota,
    };
  }
  return {
    provider: "openai",
    apiKey: fields.apiKey,
    baseUrl: fields.baseUrl,
    headers: undefined,
    model: fields.model,
    speechProtocol: "openai",
    voice,
    style,
    language: undefined,
    botLanguage,
    dailyLimit: quota.dailyLimit,
    dailyReserveQuota: quota.dailyReserveQuota,
  };
}
