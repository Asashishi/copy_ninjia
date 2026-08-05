import { readFileSync } from "node:fs";
import {
  adDetectOpenAiConfigCache,
  adDetectOpenAiConfigFailure,
  aiAgentOpenAiConfigCache,
  aiAgentOpenAiConfigFailure,
} from "../cache/perThread/config";
import { DEEPSEEK_API_BASE_URL } from "../consts/deepseek";
import { OPENAI_CONFIG_PATH } from "../consts/paths";
import { hasOnlyKeys, isPlainRecord } from "../libs/runtimeConfig";
import type { AdDetectOpenAiConfig, AiAgentOpenAiConfig, AiAgentOpenAiModels } from "../types/config";

/**
 * config/openai.json：两条 OpenAI 兼容线各自的端点与模型。
 *
 * **整份文件必填，两段的模型名一个都不能少。** 代码里不再保留任何模型默认值——
 * 有默认值就意味着「配错了也能跑起来」，而跑起来之后产出都「看起来正常」，运维
 * 要到对账时才发现自己以为换掉的模型从没生效过。缺文件、缺段、缺模型名一律抛错，
 * 由 config/readiness.ts 的探测把它变成「拒绝启动 / 拒绝开启功能」。
 *
 * 仍然可选的只有两处**端点**：ad_detect.base_url 缺省走 consts/deepseek.ts 的官方
 * 地址，ai_agent.base_url 缺省走 SDK 自带的官方端点。端点不是模型——「连哪儿」有
 * 一个人人都同意的默认值，「用哪个模型」没有。
 *
 * 未知键与拼错的键一律报错：被无声忽略的话，运维会以为自己换了模型、实际还在
 * 跑旧的——这种错发现得越晚越贵。
 *
 * **两段自始至终分开加载、分开缓存**，没有「整份文件」这个粒度的入口。理由不是
 * 省一次读盘，而是让运行时读的那一段与 config/readiness.ts 探的那一段严格相同：
 * 整份加载时，Gemini 部署写坏了从不使用的 ai_agent 段，广告检测照样通过就绪探测
 * 与启动 preflight，然后每条候选消息在取模型名时抛错、被上游 catch 吞成
 * `verdict = null`，而失败态还被缓存到进程退出为止——功能全程显示 enabled，
 * 只留一行重复日志。反向同理（ad_detect 写坏拖垮 AI 闲聊）。共用的只有顶层形状
 * 校验：整份文件都不是对象时，谁也读不出自己那一段。这条「探哪一段就只读哪一段」
 * 是跨模块约束，完整表述见 docs/04-invariants.md 的部署配置一节。
 *
 * Gemini 不受这份文件控制：它不是 OpenAI 兼容接口，端点由官方 SDK 自己管，
 * 模型另见 config/gemini.json。
 *
 * 密钥不在这里：`AI_CHAT_OPENAI_API_KEY` 与 `AD_DETECT_DEEPSEEK_API_KEY` 仍是
 * env（见 infra/config.ts）。端点与模型是「这次部署连哪儿、用哪个」的运维配置，
 * 密钥是凭据，两者的备份、权限与轮换节奏都不一样，不该混进同一份文件。
 */

/** 解码一个必填的模型名；缺了、空了、不是字符串都拒绝整份文件。 */
function requiredModel(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid OpenAI config: ${context} must be a non-empty string`);
  }
  return value.trim();
}

/** 解码一个可选的字符串字段；给了就必须是非空字符串。 */
function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid OpenAI config: ${context} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * 解码一个可选的端点地址。除了非空，还要求是能解析的 http(s) 绝对地址——
 * 少写 scheme（`ai.example.com/v1`）是最常见的手误，而 SDK 收到它只会在第一次
 * 真实请求时报一个与配置无关的错。
 */
function optionalBaseUrl(value: unknown, context: string): string | undefined {
  const raw: string | undefined = optionalString(value, context);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OpenAI config: ${context} must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid OpenAI config: ${context} must use http or https, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** 解码 ad_detect 对象；model 必填，base_url 缺省走官方地址。 */
export function parseAdDetectOpenAiConfig(value: unknown): AdDetectOpenAiConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["base_url", "model"])) {
    throw new Error("Invalid OpenAI config: ad_detect must be an object with only { base_url?, model }");
  }
  return {
    baseUrl: optionalBaseUrl(value.base_url, "ad_detect.base_url") ?? DEEPSEEK_API_BASE_URL,
    model: requiredModel(value.model, "ad_detect.model"),
  };
}

/** 解码 ai_agent.models 对象；四项全部必填。 */
function parseAiAgentModels(value: unknown): AiAgentOpenAiModels {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["reply", "summary", "media", "image"])) {
    throw new Error("Invalid OpenAI config: ai_agent.models must be an object with only { reply, summary, media, image }");
  }
  return {
    reply: requiredModel(value.reply, "ai_agent.models.reply"),
    summary: requiredModel(value.summary, "ai_agent.models.summary"),
    media: requiredModel(value.media, "ai_agent.models.media"),
    image: requiredModel(value.image, "ai_agent.models.image"),
  };
}

/** 解码 ai_agent 对象；models 必填，base_url 留空表示走官方端点。 */
export function parseAiAgentOpenAiConfig(value: unknown): AiAgentOpenAiConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["base_url", "models"])) {
    throw new Error("Invalid OpenAI config: ai_agent must be an object with only { base_url?, models }");
  }
  return {
    baseUrl: optionalBaseUrl(value.base_url, "ai_agent.base_url"),
    models: parseAiAgentModels(value.models),
  };
}

/** 顶层形状校验：只认 ad_detect 与 ai_agent 两个可选对象，两段共用。 */
function requireTopLevelRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["ad_detect", "ai_agent"])) {
    throw new Error("Invalid OpenAI config: expected an object with only { ad_detect?, ai_agent? }");
  }
  return value;
}

/**
 * 读入整份文件并只做顶层形状校验，两段各自的解码留给调用方。
 *
 * 文件不存在照样抛错：这份配置曾经整体可选、缺文件按默认值兜底，而现在代码里
 * 一个模型默认值都没有，没有可退的东西。读盘错误（不存在、权限、是目录、I/O）
 * 一律原样抛出，由就绪探测点名是哪份文件。
 */
function readOpenAiConfigRecord(path: string): Readonly<Record<string, unknown>> {
  return requireTopLevelRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 只加载并校验 ad_detect 段。
 *
 * 分段加载而不是整份加载，是因为两段的消费方完全不重叠：广告检测一个字段都
 * 不读 ai_agent，却曾经因为那半边的一个笔误被判为不可用、连带让启动 preflight
 * 中止（见 config/readiness.ts 的两个探测清单）。顶层形状仍是共用前提——整份
 * 文件都不是对象时，谁也读不出自己那一段。
 */
export function loadAdDetectOpenAiConfig(path: string = OPENAI_CONFIG_PATH): AdDetectOpenAiConfig {
  return parseAdDetectOpenAiConfig(readOpenAiConfigRecord(path).ad_detect);
}

/** 只加载并校验 ai_agent 段；理由同上。 */
export function loadAiAgentOpenAiConfig(path: string = OPENAI_CONFIG_PATH): AiAgentOpenAiConfig {
  return parseAiAgentOpenAiConfig(readOpenAiConfigRecord(path).ai_agent);
}

/**
 * ad_detect 段按进程/Worker 惰性加载一次。与其余几份 loader 同样**不在启动
 * 阶段预热**（见 config/mood.ts 的说明与 docs/04-invariants.md）。
 *
 * 成功与失败两侧都缓存：广告检测的模型名是逐消息从这里取的（见
 * workers/antiRaid/adDetect/classifier.ts），只缓存成功就意味着文件一坏，
 * Anti-Raid Worker 的每条候选消息都要重做一次同步 readFileSync + JSON.parse
 * 才抛进 catch——那条路上原本一次盘都不碰。抛出的是同一个 Error 实例，
 * 诊断文案不变。
 *
 * 只解析自己这一段：ai_agent 段的笔误不该出现在这条线程的失败态里，否则
 * adDetectConfigReadiness() 放行的配置与广告检测真正跑得起来的配置不是同一个
 * 集合（模块头注详述）。
 *
 * 与 getAiAgentOpenAiConfig() 的十行控制流是**有意重复**的，不抽成一个吃
 * `{ cache, failure, load }` 的泛型助手：本函数在 Anti-Raid Worker 上逐条候选
 * 消息被调用，两段各自的调用点因此都保持单态；共用一个助手会让那个助手同时
 * 收到两种 holder 形状而变成多态，换来的只是省下十行（见 AGENTS.md 的
 * 「性能、内存与 Bun/JSC JIT」）。
 */
export function getAdDetectOpenAiConfig(): AdDetectOpenAiConfig {
  if (adDetectOpenAiConfigCache.current !== null) return adDetectOpenAiConfigCache.current;
  if (adDetectOpenAiConfigFailure.current !== null) throw adDetectOpenAiConfigFailure.current;
  try {
    adDetectOpenAiConfigCache.current = loadAdDetectOpenAiConfig();
  } catch (error: unknown) {
    adDetectOpenAiConfigFailure.current = error instanceof Error ? error : new Error(String(error));
    throw adDetectOpenAiConfigFailure.current;
  }
  return adDetectOpenAiConfigCache.current;
}

/**
 * ai_agent 段按进程/Worker 惰性加载一次；缓存与分段语义同 getAdDetectOpenAiConfig()。
 *
 * 四条流水线每次取模型名、建客户端都要过这里（aiChat/openai/*.ts），因此同样
 * 缓存失败侧；ad_detect 段的笔误进不到这里。
 */
export function getAiAgentOpenAiConfig(): AiAgentOpenAiConfig {
  if (aiAgentOpenAiConfigCache.current !== null) return aiAgentOpenAiConfigCache.current;
  if (aiAgentOpenAiConfigFailure.current !== null) throw aiAgentOpenAiConfigFailure.current;
  try {
    aiAgentOpenAiConfigCache.current = loadAiAgentOpenAiConfig();
  } catch (error: unknown) {
    aiAgentOpenAiConfigFailure.current = error instanceof Error ? error : new Error(String(error));
    throw aiAgentOpenAiConfigFailure.current;
  }
  return aiAgentOpenAiConfigCache.current;
}
