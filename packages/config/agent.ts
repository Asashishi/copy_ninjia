import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
} from "../cache/perThread/config";
import {
  AGENT_AI_CHAT_REQUIRED_CAPABILITIES,
  AGENT_API_KEY_PLACEHOLDERS,
  AGENT_CAPABILITY_NAMES,
} from "../consts/agent";
import { AGENT_CONFIG_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../libs/record";
import type {
  AdDetectAgentConfig,
  AgentCapabilityConfig,
  AgentDeploymentConfig,
  AgentImageCapabilityConfig,
  AgentProvider,
  OpenAiImageProtocol,
} from "../types/config";

/**
 * config/agent.json：所有 AI 能力的统一部署配置。
 *
 * 顶层只含 agent；其下按能力而不是按 SDK 分组。ad_detect、text、summary、media、image、song 各自声明
 * provider、api_key、model 与可选 base_url。provider 只表示调用协议，目前只接受 google
 * 与 openai；模型品牌不受枚举限制，因此 Grok 等 OpenAI 兼容模型使用 openai
 * provider 加对应端点。text、summary、media 是对话核心能力；ad_detect、image、song
 * 均可缺省，由对应功能门禁或工具装配单独处理。非法或未知字段在
 * 建立外部连接前直接拒绝启动。
 *
 * image 额外要求 OpenAI 侧显式给 image_protocol；Google 侧禁止该字段。请求体差异
 * 不能从模型名或端点可靠推断。image/song 缺省或所选实现不支持时，分别不挂
 * 生图/生歌工具。
 *
 * **读盘只发生在主线程。** 本文件分成三段边界，谁能调哪一段由所在线程决定：
 *
 * 1. `parse*` / `load*` / `validateAgentDeploymentConfig`：解析与启动总闸，只有
 *    主线程走。总闸解析成功后把两段结果放进本 isolate 的 holder，成为进程内
 *    唯一权威快照。
 * 2. `ensure*`：主线程 readiness 探测入口。holder 已被总闸填好就直接返回，
 *    否则解析一次并填充；抛出的错误由 config/readiness.ts 缓存成功能结论。
 * 3. `get*` / `adopt*`：**只读 holder，绝不读盘**。Worker 在初始化消息里收到
 *    主线程的快照后 adopt 一次，之后每条群消息的模型名、凭据与端点都只从
 *    holder 取。Worker 崩溃重建会重放同一份快照（见 aiChat/workerBridge.ts 与
 *    antiRaid/workerBridge.ts），因此同一进程内不可能出现两代配置——「改配置
 *    必须重启进程」这句话对主线程和两条业务线程同时成立。
 */

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
 * 允许走明文 HTTP 的本机主机名；本机代理与测试端点用得到。
 *
 * `[::1]` 带方括号是因为 `URL.hostname` 对 IPv6 字面量就是这么给的。三项穷举、
 * 只在启动解析时线性比对一次，不用 Set：那会撞上「模块级 Set 必须落在
 * packages/cache/<owner>/」的归属规则，而这里根本不是缓存。
 */
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** base_url 的期望形态；解析失败与各条拒绝共用同一句，不回显被拒的值。 */
const EXPECTED_BASE_URL: string =
  "an absolute https URL without credentials or a fragment " +
  "(plain http is allowed only for localhost, 127.0.0.1, and ::1)";

/**
 * 解码可选的绝对端点；缺省交给对应 SDK 的官方地址。
 *
 * 默认只收 HTTPS：这个字段旁边就是同一项能力的 api_key，配成非本机的明文 HTTP
 * 端点等于让密钥每次请求都在网络上裸奔，而校验放行之后没有任何一层会再提醒。
 * 本机三个回环主机是例外——本地代理和测试端点是正当用法，且流量不出机器。
 *
 * userinfo 一律拒绝：`https://user:pass@host` 里的凭据既进不了脱敏名单（脱敏
 * 读的是 api_key），又会被 SDK 原样拼进每一次请求 URL，一旦进日志就是明文。
 * 认证只走 api_key 这一条路。
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

/** 解码一项普通能力；四项字段之外的拼写错误一律拒绝。 */
function parseCapability(
  value: unknown,
  context: string,
  sourcePath: string
): AgentCapabilityConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["provider", "api_key", "base_url", "model"])) {
    return invalidInput(sourcePath, context, "exactly { provider, api_key, base_url?, model }");
  }
  return {
    provider: requiredProvider(value.provider, `${context}.provider`, sourcePath),
    apiKey: requiredApiKey(value.api_key, `${context}.api_key`, sourcePath),
    baseUrl: optionalBaseUrl(value.base_url, `${context}.base_url`, sourcePath),
    model: requiredString(value.model, `${context}.model`, sourcePath),
  };
}

/** 解码生图能力；只有 OpenAI 协议分支接受并要求 image_protocol。 */
function parseImageCapability(
  value: unknown,
  sourcePath: string
): AgentImageCapabilityConfig {
  const context: string = "$.agent.image";
  if (!isPlainRecord(value)) {
    return invalidInput(sourcePath, context, "an object");
  }
  const provider: AgentProvider = requiredProvider(value.provider, `${context}.provider`, sourcePath);
  if (provider === "google") {
    if (!hasOnlyKeys(value, ["provider", "api_key", "base_url", "model"])) {
      return invalidInput(sourcePath, context, "exactly { provider, api_key, base_url?, model } when provider is google");
    }
    return {
      provider,
      apiKey: requiredApiKey(value.api_key, `${context}.api_key`, sourcePath),
      baseUrl: optionalBaseUrl(value.base_url, `${context}.base_url`, sourcePath),
      model: requiredString(value.model, `${context}.model`, sourcePath),
      imageProtocol: undefined,
    };
  }
  if (!hasOnlyKeys(value, ["provider", "api_key", "base_url", "model", "image_protocol"])) {
    return invalidInput(
      sourcePath,
      context,
      "exactly { provider, api_key, base_url?, model, image_protocol } when provider is openai"
    );
  }
  return {
    provider,
    apiKey: requiredApiKey(value.api_key, `${context}.api_key`, sourcePath),
    baseUrl: optionalBaseUrl(value.base_url, `${context}.base_url`, sourcePath),
    model: requiredString(value.model, `${context}.model`, sourcePath),
    imageProtocol: requiredImageProtocol(value.image_protocol, `${context}.image_protocol`, sourcePath),
  };
}

/** 解码广告检测能力；base_url 缺省时跟随所选 SDK 的官方端点。 */
export function parseAdDetectAgentConfig(
  value: unknown,
  sourcePath: string = AGENT_CONFIG_PATH
): AdDetectAgentConfig {
  return parseCapability(value, "$.agent.ad_detect", sourcePath);
}

/** 严格解码 agent 段；三项对话必备能力不能缺，其余能力可显式缺省。 */
export function parseAgentDeploymentConfig(
  value: unknown,
  sourcePath: string = AGENT_CONFIG_PATH
): AgentDeploymentConfig {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, AGENT_CAPABILITY_NAMES) ||
    !AGENT_AI_CHAT_REQUIRED_CAPABILITIES.every(
      (key: string): boolean => Object.hasOwn(value, key)
    )
  ) {
    return invalidInput(
      sourcePath,
      "$.agent",
      "exactly { ad_detect?, text, summary, media, image?, song? }"
    );
  }
  let song: AgentCapabilityConfig | undefined;
  if (value.song !== undefined) {
    song = parseCapability(value.song, "$.agent.song", sourcePath);
  }
  const image: AgentImageCapabilityConfig | undefined = value.image === undefined
    ? undefined
    : parseImageCapability(value.image, sourcePath);
  return {
    text: parseCapability(value.text, "$.agent.text", sourcePath),
    summary: parseCapability(value.summary, "$.agent.summary", sourcePath),
    media: parseCapability(value.media, "$.agent.media", sourcePath),
    image,
    song,
  };
}

/** 顶层只允许 agent；能力 getter 在它下面各自消费。 */
function requireAgentRecord(
  value: unknown,
  sourcePath: string
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["agent"])) {
    return invalidInput(sourcePath, "$", "exactly { agent }");
  }
  if (!isPlainRecord(value.agent)) {
    return invalidInput(sourcePath, "$.agent", "an object");
  }
  return value.agent;
}

/** 读入统一配置并只校验顶层，具体能力由消费方严格解析。 */
async function readAgentConfigRecord(
  path: string
): Promise<Readonly<Record<string, unknown>>> {
  return requireAgentRecord(await readJsonInput(path), path);
}

/** 启动总闸严格校验整份已存在的 agent.json，并填充默认路径缓存。 */
export async function validateAgentDeploymentConfig(
  path: string = AGENT_CONFIG_PATH
): Promise<void> {
  const record: Readonly<Record<string, unknown>> = await readAgentConfigRecord(path);
  if (!hasOnlyKeys(record, AGENT_CAPABILITY_NAMES)) {
    return invalidInput(
      path,
      "$.agent",
      "only { ad_detect?, text?, summary?, media?, image?, song? }"
    );
  }
  const adDetectConfig: AdDetectAgentConfig | undefined = record.ad_detect === undefined
    ? undefined
    : parseAdDetectAgentConfig(record.ad_detect, path);
  if (record.text !== undefined) parseCapability(record.text, "$.agent.text", path);
  if (record.summary !== undefined) parseCapability(record.summary, "$.agent.summary", path);
  if (record.media !== undefined) parseCapability(record.media, "$.agent.media", path);
  if (record.image !== undefined) parseImageCapability(record.image, path);
  if (record.song !== undefined) {
    parseCapability(record.song, "$.agent.song", path);
  }
  const hasAiChatCore: boolean = AGENT_AI_CHAT_REQUIRED_CAPABILITIES.every(
    (key: string): boolean => Object.hasOwn(record, key)
  );
  const agentConfig: AgentDeploymentConfig | undefined = hasAiChatCore
    ? parseAgentDeploymentConfig(record, path)
    : undefined;
  if (path === AGENT_CONFIG_PATH) {
    adDetectAgentConfigCache.current = adDetectConfig ?? null;
    agentDeploymentConfigCache.current = agentConfig ?? null;
  }
}

/** 只加载广告检测段。 */
export async function loadAdDetectAgentConfig(
  path: string = AGENT_CONFIG_PATH
): Promise<AdDetectAgentConfig> {
  const record: Readonly<Record<string, unknown>> = await readAgentConfigRecord(path);
  return parseAdDetectAgentConfig(record.ad_detect, path);
}

/** 只加载 AI agent 段。 */
export async function loadAgentDeploymentConfig(
  path: string = AGENT_CONFIG_PATH
): Promise<AgentDeploymentConfig> {
  return parseAgentDeploymentConfig(await readAgentConfigRecord(path), path);
}

/**
 * 主线程 readiness 探测入口（ad_detect 段）。启动总闸已经填好 holder 时直接
 * 返回，保证已存在的文件在一个进程里只解析一次；holder 为空——文件缺省，或
 * 文件在但没有 ad_detect 段——才解析一次并让错误逃出去，由
 * config/readiness.ts 缓存成功能结论（成功与失败都缓存，见该文件头注）。
 */
export async function ensureAdDetectAgentConfig(): Promise<void> {
  if (adDetectAgentConfigCache.current !== null) return;
  adDetectAgentConfigCache.current = await loadAdDetectAgentConfig();
}

/** 主线程 readiness 探测入口（AI 对话核心能力段）；语义同上。 */
export async function ensureAgentDeploymentConfig(): Promise<void> {
  if (agentDeploymentConfigCache.current !== null) return;
  agentDeploymentConfigCache.current = await loadAgentDeploymentConfig();
}

/**
 * Anti-Raid Worker 初始化消息要投递的 ad_detect 快照。
 *
 * 返回 null 表示**明确未配置**（文件缺省，或文件在但没有 ad_detect 段），不是
 * 「还没读」：调用点在启动总闸之后，文件一旦存在且该段非法，进程早已带着字段
 * 路径退出。Worker 侧据此 fail-closed，不会沿用上一实例的值。
 */
export function adDetectAgentConfigSnapshot(): AdDetectAgentConfig | null {
  return adDetectAgentConfigCache.current;
}

/**
 * Worker 侧接管主线程投递过来的 ad_detect 快照。
 *
 * 每次初始化/重建都无条件赋值（含显式 null），不做 `??=`：崩溃重建的新 isolate
 * holder 本来就是空的，写成条件赋值只会在将来有人复用这条通道时把「这次明确
 * 没配」误读成「沿用上次」。
 */
export function adoptAdDetectAgentConfig(config: AdDetectAgentConfig | null): void {
  adDetectAgentConfigCache.current = config;
}

/** Worker 侧接管主线程投递过来的 AI 对话能力快照；语义同上。 */
export function adoptAgentDeploymentConfig(config: AgentDeploymentConfig): void {
  agentDeploymentConfigCache.current = config;
}

/**
 * 读取本 isolate 的 ad_detect 配置。**只读 holder，不读盘。**
 *
 * 主线程由启动总闸填充，Anti-Raid Worker 由初始化消息填充。取不到只可能是
 * 「这个部署没配广告检测」或「配置消息还没到」，两种都必须 fail-closed：主线程
 * 那道 adDetectConfigReadiness 门禁本就拦住了候选消息，走到这里说明调用序有
 * 问题，猜一个默认值只会让判定用着不存在的模型继续拉黑人。
 */
export function getAdDetectAgentConfig(): AdDetectAgentConfig {
  const config: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
  if (config === null) {
    throw new Error(
      `Ad detection agent configuration is unavailable in this thread; ${AGENT_CONFIG_PATH} $.agent.ad_detect was never delivered.`
    );
  }
  return config;
}

/** 读取本 isolate 的 AI 对话能力配置；语义同 getAdDetectAgentConfig。 */
export function getAgentDeploymentConfig(): AgentDeploymentConfig {
  const config: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  if (config === null) {
    throw new Error(
      `AI chat agent configuration is unavailable in this thread; ${AGENT_CONFIG_PATH} $.agent was never delivered.`
    );
  }
  return config;
}
