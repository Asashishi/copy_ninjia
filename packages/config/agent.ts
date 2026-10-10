import {
  AGENT_AI_CHAT_REQUIRED_CAPABILITIES,
  AGENT_CAPABILITY_NAMES,
} from "../consts/agent";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
} from "../cache/perThread/config";
import { AGENT_CONFIG_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../libs/record";
import { parseCapability, parseImageCapability, parseTtsCapability, parseWebSearchCapability } from "./agentCapability";
import type {
  AdDetectAgentConfig,
  AgentCapability,
  AgentCapabilityConfig,
  AgentConfigSnapshots,
  AgentDeploymentCapabilityConfig,
  AgentDeploymentConfig,
  AgentGeneralCapability,
  AgentImageCapabilityConfig,
  AgentTtsCapabilityConfig,
  AgentWebSearchCapabilityConfig,
} from "../types/config";

/**
 * config/dynamic/agent.json：所有 AI 能力的统一部署配置。
 *
 * 顶层只含 agent；其下按能力分组。ad_detect、text、summary、media、image、tts、web_search 各自声明
 * provider、api_key、model 与可选 base_url；google 与 anthropic provider 另可声明 headers，给每个请求
 * 附加请求头（Cloudflare AI Gateway 等三方网关鉴权），openai provider 不接受该字段；anthropic provider 另可
 * 声明与 model 不同的 fallback_model，model 拒答时用它重发同一请求。provider 只表示调用协议，接受
 * google、openai 与 anthropic；Grok 等 OpenAI 兼容模型使用 openai provider 加对应端点。
 * text、summary、media 是对话核心能力；ad_detect、image、tts、web_search
 * 均可缺省，由对应功能门禁或工具装配单独处理。web_search 由它的模型执行带内建检索的单轮请求，
 * 可选 max_calls_per_use 指定每轮回复最多调用该函数的次数，缺省使用 WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE。
 * 非法或未知字段在建立外部连接前直接拒绝启动。
 *
 * image 额外要求 OpenAI 侧显式给 image_protocol；Google 侧禁止该字段。
 * tts 额外要求 voice，只校验为非空字符串，音色是否存在由首次
 * 合成请求决定；OpenAI 侧另要求 speech_protocol（`openai` 为 audio/speech，`xai` 为 xAI
 * `POST /tts`），Google 侧禁止该字段。可选 style 指定基础风格，缺省使用 TTS_DEFAULT_STYLE；
 * xai 协议没有模型名与风格指令，出现 model 或 style 即拒绝，另有可选 language（缺省 `auto`）。
 * 各协议都接受可选 bot_language（`en`、`zh` 或 `ja`，缺省 TTS_DEFAULT_BOT_LANGUAGE），只决定
 * AI 回复取哪一份语音相关提示词。
 * 可选的 daily_limit 与 daily_reserve_quota 将每日预算拆为 AI 与 `/send`、cron 共用的预留额度，
 * 两边独立计数。image/tts 缺省或所选实现不支持时，分别不挂生图/语音工具。
 *
 * **读盘只发生在主线程。** 本文件按所在线程分为以下边界：
 *
 * 1. `parse*` / `load*` / `validateAgentDeploymentConfig`：解析与启动总闸，只有
 *    主线程走。总闸解析成功后把两段结果放进本 isolate 的 holder，成为主线程的
 *    权威快照；运行期由 config/reload.ts 用同一份 loadAgentConfigSnapshots 严格
 *    解析改过的文件，通过后整体替换 holder。
 * 2. `*Snapshot` / `get*` / `adopt*`：**只读 holder，绝不读盘**。`*Snapshot` 返回可空的当前快照
 *    （null 表示明确未配置），`get*` 取不到时抛错。Worker 只 adopt 主线程经初始化
 *    消息与热重载消息投递的快照，每条群消息的模型名、凭据与端点都只从 holder 取。
 *    Worker 崩溃重建重放的是主线程当前生效的那份快照（见 aiChat/workerBridge.ts
 *    与 antiRaid/workerBridge/controller.ts），Worker 自己从不读盘。
 */

/** 解码广告检测能力；base_url 缺省时跟随所选 SDK 的官方端点。 */
export function parseAdDetectAgentConfig(
  value: unknown,
  sourcePath: string = AGENT_CONFIG_PATH
): AdDetectAgentConfig {
  return parseCapability(value, "$.agent.ad_detect", sourcePath);
}

/** 严格解码 agent 段；对话必备能力不能缺，其余能力可显式缺省。 */
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
      "exactly { ad_detect?, text, summary, media, image?, tts?, web_search? }"
    );
  }
  let tts: AgentTtsCapabilityConfig | undefined;
  if (value.tts !== undefined) {
    tts = parseTtsCapability(value.tts, sourcePath);
  }
  const image: AgentImageCapabilityConfig | undefined = value.image === undefined
    ? undefined
    : parseImageCapability(value.image, sourcePath);
  const webSearch: AgentWebSearchCapabilityConfig | undefined = value.web_search === undefined
    ? undefined
    : parseWebSearchCapability(value.web_search, sourcePath);
  return {
    text: parseCapability(value.text, "$.agent.text", sourcePath),
    summary: parseCapability(value.summary, "$.agent.summary", sourcePath),
    media: parseCapability(value.media, "$.agent.media", sourcePath),
    image,
    tts,
    webSearch,
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

/** 严格解析整份已存在的 agent.json：已出现的每项能力都必须合法，缺省的段返回 null。 */
export async function loadAgentConfigSnapshots(
  path: string = AGENT_CONFIG_PATH
): Promise<AgentConfigSnapshots> {
  const record: Readonly<Record<string, unknown>> = await readAgentConfigRecord(path);
  if (!hasOnlyKeys(record, AGENT_CAPABILITY_NAMES)) {
    return invalidInput(
      path,
      "$.agent",
      "only { ad_detect?, text?, summary?, media?, image?, tts?, web_search? }"
    );
  }
  const adDetectConfig: AdDetectAgentConfig | undefined = record.ad_detect === undefined
    ? undefined
    : parseAdDetectAgentConfig(record.ad_detect, path);
  if (record.text !== undefined) parseCapability(record.text, "$.agent.text", path);
  if (record.summary !== undefined) parseCapability(record.summary, "$.agent.summary", path);
  if (record.media !== undefined) parseCapability(record.media, "$.agent.media", path);
  if (record.image !== undefined) parseImageCapability(record.image, path);
  if (record.tts !== undefined) {
    parseTtsCapability(record.tts, path);
  }
  if (record.web_search !== undefined) parseWebSearchCapability(record.web_search, path);
  const hasAiChatCore: boolean = AGENT_AI_CHAT_REQUIRED_CAPABILITIES.every(
    (key: string): boolean => Object.hasOwn(record, key)
  );
  const agentConfig: AgentDeploymentConfig | null = hasAiChatCore
    ? parseAgentDeploymentConfig(record, path)
    : null;
  return { adDetect: adDetectConfig ?? null, agent: agentConfig };
}

/** 启动总闸严格校验整份已存在的 agent.json，并填充默认路径缓存。 */
export async function validateAgentDeploymentConfig(
  path: string = AGENT_CONFIG_PATH
): Promise<void> {
  const snapshots: AgentConfigSnapshots = await loadAgentConfigSnapshots(path);
  if (path === AGENT_CONFIG_PATH) {
    adDetectAgentConfigCache.current = snapshots.adDetect;
    agentDeploymentConfigCache.current = snapshots.agent;
  }
}

/**
 * 本 isolate 当前的 ad_detect 快照：主线程据此投递 Anti-Raid Worker 初始化消息，Worker 侧
 * 接管新快照前据此判断 agent.ad_detect 是否变化。
 *
 * 返回 null 表示**明确未配置**（文件缺省，或文件在但没有 ad_detect 段），不是
 * 「还没读」：调用点在启动总闸之后，文件一旦存在且该段非法，进程早已带着字段
 * 路径退出。Worker 侧据此 fail-closed，不会沿用上一实例的值。
 */
export function adDetectAgentConfigSnapshot(): AdDetectAgentConfig | null {
  return adDetectAgentConfigCache.current;
}

/**
 * 本 isolate 当前的对话能力快照；null 表示明确未配置（文件或对话核心能力段缺省），语义同
 * adDetectAgentConfigSnapshot。cron.json 的启动核对据此判断依赖 agent 的动作能否生效。
 */
export function agentDeploymentConfigSnapshot(): AgentDeploymentConfig | null {
  return agentDeploymentConfigCache.current;
}

/**
 * 接管已严格校验的 ad_detect 快照：Worker 侧来自主线程的初始化、重建与热重载
 * 消息，主线程侧来自 config/reload.ts。
 *
 * 每次都无条件整体赋值（含显式 null），不做 `??=`，也不就地改写旧对象；
 * logger 的凭据脱敏按 holder 的对象身份判断是否重算。
 */
export function adoptAdDetectAgentConfig(config: AdDetectAgentConfig | null): void {
  adDetectAgentConfigCache.current = config;
}

/** 接管已严格校验的 AI 对话能力快照；来源与语义同上，null 表示文件或对话核心能力段已删除。 */
export function adoptAgentDeploymentConfig(config: AgentDeploymentConfig | null): void {
  agentDeploymentConfigCache.current = config;
}

/**
 * 读取本 isolate 的 ad_detect 配置。**只读 holder，不读盘。**
 *
 * 主线程由启动总闸与热重载填充，Anti-Raid Worker 由主线程的 agentConfig 消息填充。取不到表示
 * 「这个部署没配广告检测」或「配置消息还没到」，两种都 fail-closed 抛错：主线程
 * 的 adDetectConfigReadiness 门禁已拦住候选消息，走到这里说明调用序有问题。
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

/**
 * 按能力名读取本 isolate 的能力配置；`web_search` 对应 AgentDeploymentConfig.webSearch，其余
 * 能力名与字段名相同。可缺省的能力没配时为 undefined。只读 holder，不读盘；各家 SDK 客户端
 * 缓存据此按能力取凭据与端点。
 */
export function agentCapabilityConfig(capability: AgentCapability): AgentDeploymentCapabilityConfig | undefined {
  const config: AgentDeploymentConfig = getAgentDeploymentConfig();
  return capability === "web_search" ? config.webSearch : config[capability];
}

/**
 * 按能力名读取三项对话核心能力或独立检索 `web_search` 的配置；未配置时抛错，不做凭据或故障
 * 回退。只读 holder，不读盘；回复、摘要、视觉与检索的请求体据此取模型。
 */
export function requireAgentCapabilityConfig(capability: AgentGeneralCapability): AgentCapabilityConfig {
  const deployment: AgentDeploymentConfig = getAgentDeploymentConfig();
  const config: AgentCapabilityConfig | undefined = capability === "web_search"
    ? deployment.webSearch
    : deployment[capability];
  if (config === undefined) throw new Error(`Agent capability "${capability}" is not configured.`);
  return config;
}

/**
 * 本 isolate 当前的 `agent.tts` 配置；文件、对话核心能力段或 tts 段缺省时为 undefined。
 * 只读 holder，不读盘。主线程的 `/send` 代发 TTS、cron `send_voice` 与 cron.json 的
 * 交叉校验据此判定语音合成是否已配置，`/send` 的额度提示读它的 dailyReserveQuota；AI Worker 的
 * 语音余量与余量行读它的 dailyLimit 与 dailyReserveQuota。
 */
export function agentTtsConfig(): AgentTtsCapabilityConfig | undefined {
  return agentDeploymentConfigCache.current?.tts;
}
