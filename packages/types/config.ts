/**
 * 部署配置可用性判定的共享类型（判定本身见 packages/config/readiness.ts，
 * 缓存 holder 见 packages/cache/perThread/config.ts）。
 */

import type { ReactionTypeEmoji } from "@grammyjs/types";
import type { MoodOption } from "./aiChat/mood";

/** Telegram Bot API 标准 emoji 反应的精确联合。 */
export type ReactionEmoji = ReactionTypeEmoji["emoji"];

/** reactions.json 的严格结构。 */
export interface ReactionConfig {
  readonly emotionKeywords: Readonly<Partial<Record<ReactionEmoji, readonly string[]>>>;
}

/** stickers.json 的严格结构。 */
export interface StickerConfig {
  readonly packs: readonly string[];
}

/** mood.json 的严格结构。 */
export interface MoodConfig {
  readonly moods: readonly MoodOption[];
}

/**
 * 广告检测的部署者示例清单：config/ad_samples.json 是一个纯字符串数组，每条
 * 是一段“应当被判成广告”的原文。文件本身是判定口径的唯一可调旋钮，改它
 * 不需要动代码，见 workers/antiRaid/adDetect/classifier.ts。
 */
export type AdSampleConfig = readonly string[];

/**
 * ad_detect 一侧的 OpenAI 兼容端点配置，已按 consts 默认值兜底。
 *
 * 与 AiAgentOpenAiConfig 同住 config/openai.json，但**没有一个合并类型把两者装在
 * 一起**：两段的消费方完全不重叠（这条走广告检测的 DeepSeek 线，那条走 AI 闲聊的
 * agent 流水线），各用各的凭据与端点。曾经有过一个 OpenAiDeploymentConfig 把两段
 * 并成一个值，代价是运行时取任一段都要先解析整份文件——于是 ai_agent 的一个笔误
 * 能让广告检测在通过就绪探测之后才静默失效（见 config/openai.ts 的分段加载）。
 *
 * Gemini 不受这份文件控制——它不是 OpenAI 兼容接口，端点由官方 SDK 自己管，
 * 模型另见 config/gemini.json。
 */
export interface AdDetectOpenAiConfig {
  readonly baseUrl: string;
  readonly model: string;
}

/** ai_agent 一侧四条流水线各自的模型名；四项全部必填，代码不再持有默认值。 */
export interface AiAgentOpenAiModels {
  readonly reply: string;
  readonly summary: string;
  readonly media: string;
  readonly image: string;
}

/** ai_agent 一侧的 OpenAI 端点配置；models 必填，base_url 留空表示走官方端点。 */
export interface AiAgentOpenAiConfig {
  /** 留空表示走 SDK 默认的官方端点。 */
  readonly baseUrl: string | undefined;
  readonly models: AiAgentOpenAiModels;
}

/**
 * config/gemini.json 的模型名；四项全部必填。
 *
 * 与 AiAgentOpenAiModels 逐字段同名同义，但**各留一份**：两家的模型命名空间毫无
 * 交集，合并成一个类型只会让「换一家就要顺手改另一家」这种错误在类型上看不出来。
 */
export interface GeminiModels {
  readonly reply: string;
  readonly summary: string;
  readonly media: string;
  readonly image: string;
}

/**
 * config/gemini.json 的解析结果。
 *
 * 只有 models 一项：Gemini 走官方 SDK，端点不可配（这正是它与 openai.json 的
 * 结构差别，不是遗漏）。密钥仍是 env 的 `AI_CHAT_GEMINI_API_KEY`，理由同
 * config/openai.ts 的模块头注——端点模型是运维配置，密钥是凭据。
 */
export interface GeminiDeploymentConfig {
  readonly models: GeminiModels;
}

/** 一份坏掉的部署文件：文件名给人看，诊断给日志看。 */
export interface ConfigFailure {
  /** 相对项目根的路径，如 `config/stickers.json`；直接出现在命令的拒绝文案里。 */
  readonly file: string;
  /** 解析器/文件系统给出的英文诊断，只进日志（见 AGENTS.md 的日志约定）。 */
  readonly reason: string;
}

/** 某个功能所需的全部部署配置是否可用。 */
export type ConfigReadiness =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ConfigFailure };

/** 单份部署文件的探测项：文件名 + 一次会在坏掉时抛出的加载。 */
export interface DeploymentFileProbe {
  readonly file: string;
  readonly load: () => unknown;
}

/** 判定结论的单例缓存 holder；成功与失败都缓存，见 config/readiness.ts 头注。 */
export interface ConfigReadinessCache {
  current: ConfigReadiness | null;
}
