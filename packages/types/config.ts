/**
 * 部署配置可用性判定的共享类型（判定本身见 packages/config/readiness.ts，
 * 缓存 holder 见 packages/cache/perThread/config.ts）。
 */

import type { CronConfig } from "./cron";
import type { MoodOption } from "./aiChat/mood";

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

/** Telegram Bot 身份与超级管理员身份的进程级部署配置。 */
export interface TelegramConfig {
  /** BotFather 发放的 Bot API token。 */
  readonly botToken: string;
  /** 唯一超级管理员的正安全整数 Telegram 用户 ID。 */
  readonly superAdminUserId: number;
}

/** Google 翻译 SDK 实际消费的服务账号字段；官方密钥的其它元数据由 SDK 保留。 */
export interface GoogleServiceAccountKey {
  readonly type?: "service_account";
  readonly client_email: string;
  readonly private_key: string;
  readonly private_key_id?: string;
  readonly project_id?: string;
  readonly quota_project_id?: string;
  readonly universe_domain?: string;
}

/**
 * ad_detect 能力配置。与其他能力一样显式选择 Google 或 OpenAI 协议；端点缺省
 * 时跟随对应 SDK 的官方地址，兼容端点必须在该能力自己的 base_url 显式声明。
 *
 * 与 AI agent 配置同住 config/agent.json，但运行时仍按消费方分段加载：广告检测
 * Worker 不接触闲聊能力配置，AI Worker 也不读取广告模型。分段边界见
 * config/agent.ts。
 */
export type AdDetectAgentConfig = AgentCapabilityConfig;

/**
 * OpenAI 兼容生图的线协议。
 *
 * 这是请求体能力边界，不是模型供应商或模型名枚举：`openai` 表示 gpt-image-2
 * 任意尺寸协议，`openai-standard` 表示 GPT Image 全系共同支持的三种标准尺寸，
 * `xai` 表示 xAI JSON/画幅协议。同一个代理端点也必须显式选择；后续新增不兼容
 * 的 images 请求形状时，在这里和 aiChat/openai/image.ts 的穷举分派同步增加一档。
 */
export type OpenAiImageProtocol = "openai" | "openai-standard" | "xai";

/** agent 能力可选的两种 SDK 协议；模型品牌不在这里枚举。 */
export type AgentProvider = "google" | "openai";

/** agent 配置中的能力名；每项分别选择 provider、模型与端点。 */
export type AgentCapability = "text" | "summary" | "media" | "image" | "song";

/** Google GenAI SDK 承载的一项能力配置。 */
export interface GoogleAgentCapabilityConfig {
  readonly provider: "google";
  readonly apiKey: string;
  /** 留空表示走 Google SDK 的官方端点。 */
  readonly baseUrl: string | undefined;
  readonly model: string;
}

/** OpenAI SDK（含 OpenAI 兼容端点）承载的一项能力配置。 */
export interface OpenAiAgentCapabilityConfig {
  readonly provider: "openai";
  readonly apiKey: string;
  /** 留空表示走 OpenAI SDK 的官方端点。 */
  readonly baseUrl: string | undefined;
  readonly model: string;
}

/** 不涉及生图请求体差异的通用能力配置。 */
export type AgentCapabilityConfig = GoogleAgentCapabilityConfig | OpenAiAgentCapabilityConfig;

/** Google 生图配置；Google SDK 自己定义请求体，不接受 OpenAI 协议档位。 */
export interface GoogleAgentImageCapabilityConfig extends GoogleAgentCapabilityConfig {
  readonly imageProtocol: undefined;
}

/** OpenAI 兼容生图配置；协议必须显式给出，不能从模型名或端点猜测。 */
export interface OpenAiAgentImageCapabilityConfig extends OpenAiAgentCapabilityConfig {
  readonly imageProtocol: OpenAiImageProtocol;
}

/** 生图能力配置。 */
export type AgentImageCapabilityConfig =
  | GoogleAgentImageCapabilityConfig
  | OpenAiAgentImageCapabilityConfig;

/**
 * config/agent.json 的 agent 段；三项对话核心能力必填且各自独立路由。
 * `text` 是带工具往返的群聊回复，`summary` 是无状态纯文本摘要，`media` 是视觉
 * 描述与语音转写，`image` 是生图，`song` 是生歌。
 */
export interface AgentDeploymentConfig {
  readonly text: AgentCapabilityConfig;
  readonly summary: AgentCapabilityConfig;
  readonly media: AgentCapabilityConfig;
  /** 缺省不影响 AI 对话，只是不注册生图工具。 */
  readonly image?: AgentImageCapabilityConfig;
  /** 缺省表示不提供生歌工具；实现不支持时同样不会注册对应工具。 */
  readonly song?: AgentCapabilityConfig;
}

/**
 * 整份 config/agent.json 严格解析后的两段快照；null 表示该段在文件里缺省
 * （文件本身缺省时两段都是 null）。分段边界见 config/agent.ts。
 */
export interface AgentConfigSnapshots {
  readonly adDetect: AdDetectAgentConfig | null;
  readonly agent: AgentDeploymentConfig | null;
}

/**
 * 一份可热重载部署文件的一次读取：文件真正不存在、严格解析通过，或带安全诊断
 * 的失败（诊断口径同 InputValidationError，只含文件路径、字段路径与期望形态）。
 */
export type HotConfigRead<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "loaded"; readonly value: T }
  | { readonly kind: "invalid"; readonly reason: string };

/** config/reload.ts 对五份可热重载部署文件的一轮读取。 */
export interface HotDeploymentConfigReads {
  readonly adSamples: HotConfigRead<AdSampleConfig>;
  readonly agent: HotConfigRead<AgentConfigSnapshots>;
  readonly mood: HotConfigRead<MoodConfig>;
  readonly stickers: HotConfigRead<StickerConfig>;
  readonly cron: HotConfigRead<CronConfig>;
}

/**
 * 一轮热重载实际替换的主线程快照、生效与删除的文件，以及被拒绝变更的诊断。
 * 各布尔字段为 true 表示对应 holder 已整体替换，包括因文件或段被删除而换成 null。
 */
export interface HotDeploymentConfigChanges {
  /** agent.json 的 ad_detect 段快照已替换。 */
  readonly adDetect: boolean;
  /** agent.json 的 AI 对话能力段快照已替换。 */
  readonly aiAgent: boolean;
  readonly adSamples: boolean;
  readonly mood: boolean;
  readonly stickers: boolean;
  /** cron.json 的任务表已替换。 */
  readonly cron: boolean;
  /** 仍然存在、且至少替换了一份快照的文件路径。 */
  readonly reloadedPaths: readonly string[];
  /** 本轮被删除、对应快照已清空的文件路径。 */
  readonly removedPaths: readonly string[];
  /** 被拒绝变更的英文诊断；对应 holder 保留上一份已校验快照。 */
  readonly rejections: readonly string[];
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
  readonly load: () => Promise<unknown>;
}

/** 判定结论的单例缓存 holder；成功与失败都缓存，见 config/readiness.ts 头注。 */
export interface ConfigReadinessCache {
  current: ConfigReadiness | null;
}
