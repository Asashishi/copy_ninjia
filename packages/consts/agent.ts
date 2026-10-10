import type { AgentHeadersProvider, AgentProvider } from "../types/config";
import { exhaustiveList } from "./exhaustiveList";

/**
 * `config/dynamic/agent.json` 的 `agent` 段允许出现的全部能力名，顺序与
 * `config_example/dynamic/agent.json` 一致。
 *
 * 这份名单是唯一权威源：`packages/config/agent.ts` 的 `hasOnlyKeys` 校验用它
 * 决定「未知字段一律拒绝」，install.sh 的安装问卷按同一份名单逐项询问，
 * 由 `test/scripts/installScript.test.ts` 与本常量对拍。新增能力必须改这里，
 * 并同步能力档解析、示例文件与三语文档。
 *
 * 所属模块：AI 能力部署配置。
 */
export const AGENT_CAPABILITY_NAMES: readonly string[] = [
  "ad_detect",
  "text",
  "summary",
  "media",
  "image",
  "tts",
  "web_search",
];

/**
 * AI 闲聊可用的必备能力：三项齐备才算对话核心成立，缺任意一项
 * `/ai_chat enable` 会被拒绝（见 packages/aiChat/availability.ts）。
 *
 * 必须是 AGENT_CAPABILITY_NAMES 的子集；install.sh 用同一份名单判断问卷
 * 是否问全了必填项。所属模块：AI 能力部署配置。
 */
export const AGENT_AI_CHAT_REQUIRED_CAPABILITIES: readonly string[] = [
  "text",
  "summary",
  "media",
];

/**
 * agent 段 provider 的完整闭集；部署配置解析（config/agentCapability.ts）与 AI 用量文件解码
 * （workers/diskIO/aiCacheDocument.ts）共用。新增 provider 时同步 AgentProvider、
 * AGENT_PROVIDER_LABELS 与 aiChat/provider.ts 的实现包映射。所属模块：AI 能力部署配置。
 */
export const AGENT_PROVIDERS: readonly AgentProvider[] = exhaustiveList<AgentProvider>()(["google", "openai", "anthropic"]);

/** 判断字符串是否属于 AGENT_PROVIDERS；调用方先完成首尾空白规范化。所属模块：AI 能力部署配置。 */
export function isAgentProvider(value: string): value is AgentProvider {
  return (AGENT_PROVIDERS as readonly string[]).includes(value);
}

/** 各 provider 在错误文案里的名称（SDK 客户端未按能力配置时）。所属模块：aiChat/capabilityClient.ts。 */
export const AGENT_PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/** Agent 部署示例实际使用的占位凭据；严格解析只拒绝这些已知无效值。 */
export const AGENT_API_KEY_PLACEHOLDERS: readonly string[] = [
  "replace-with-anthropic-api-key",
  "replace-with-deepseek-api-key",
  "replace-with-google-api-key",
  "replace-with-openai-api-key",
  "replace-with-xai-api-key",
];

/** Agent 配置允许使用明文 HTTP 的回环主机闭集。 */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Agent base_url 严格校验的期望形态，不含用户配置值。 */
export const EXPECTED_BASE_URL: string =
  "an absolute https URL without credentials or a fragment " +
  "(plain http is allowed only for localhost, 127.0.0.1, and ::1)";

/**
 * google 与 anthropic provider 能力的 headers 最多条数。每个值都进日志值级脱敏名单，
 * 各项能力按上限配满时名单仍在 LOGGER_MAX_REDACTED_SECRETS 之内。
 * 所属模块：AI 能力部署配置。
 */
export const AGENT_HEADERS_MAX_ENTRIES: number = 8;

/** web_search 缺省的每轮函数调用上限；由配置解析补齐，与 text 内建搜索预算独立。所属模块：AI 能力部署配置。 */
export const WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE: number = 5;

/**
 * 接受 headers 的 provider 各自的 SDK 凭据头名（小写）：凭据只走 api_key，由 SDK 写进该头；headers 里
 * 出现同名头（忽略大小写）即拒绝。所属模块：AI 能力部署配置。
 */
export const AGENT_CREDENTIAL_HEADER_NAMES: Readonly<Record<AgentHeadersProvider, string>> = {
  google: "x-goog-api-key",
  anthropic: "x-api-key",
};

/** headers 的请求头名形态：RFC 9110 token。所属模块：AI 能力部署配置。 */
export const AGENT_HEADER_NAME_PATTERN: RegExp = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** headers 去掉首尾空白后的请求头值形态：可打印 ASCII 与空格、制表符。所属模块：AI 能力部署配置。 */
export const AGENT_HEADER_VALUE_PATTERN: RegExp = /^[\t\x20-\x7e]+$/;

/** 按 provider 的凭据头名拼出 headers 对象的期望形态。 */
function expectedAgentHeaders(credentialHeader: string): string {
  return `an object of 1 to ${AGENT_HEADERS_MAX_ENTRIES} HTTP header names (tokens, unique ignoring case, ` +
    `not ${credentialHeader}; use api_key) mapped to string values`;
}

/** headers 对象严格校验的期望形态（按 provider），不含用户配置值。所属模块：AI 能力部署配置。 */
export const EXPECTED_AGENT_HEADERS: Readonly<Record<AgentHeadersProvider, string>> = {
  google: expectedAgentHeaders(AGENT_CREDENTIAL_HEADER_NAMES.google),
  anthropic: expectedAgentHeaders(AGENT_CREDENTIAL_HEADER_NAMES.anthropic),
};

/** headers 单个请求头值严格校验的期望形态，不含用户配置值。所属模块：AI 能力部署配置。 */
export const EXPECTED_AGENT_HEADER_VALUE: string = "a non-empty string of printable ASCII characters";

/** anthropic provider 能力的 fallback_model 严格校验的期望形态，不含用户配置值。所属模块：AI 能力部署配置。 */
export const EXPECTED_AGENT_FALLBACK_MODEL: string = "a non-empty string different from model";
