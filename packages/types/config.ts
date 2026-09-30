/**
 * 部署配置的共享类型：各部署文件的解析结果、热重载的读取与变更记录，以及配置可用性
 * 判定（判定本身见 packages/config/readiness.ts，缓存 holder 见
 * packages/cache/perThread/config.ts）。
 */

import type { BotAtmosphere } from "./atmosphere";
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
 * 广告检测的部署者示例清单：config/dynamic/ad_samples.json 是一个纯字符串数组，每条
 * 是一段“应当被判成广告”的原文。文件本身是判定口径的唯一可调旋钮，改它
 * 不需要动代码，见 workers/antiRaid/adDetect/classifier.ts。
 */
export type AdSampleConfig = readonly string[];

/** Bot 身份、超级管理员身份与默认通知风格的进程级部署配置。 */
export interface BotConfig {
  /** BotFather 发放的 Bot API token。 */
  readonly botToken: string;
  /** 唯一超级管理员的正安全整数 Telegram 用户 ID。 */
  readonly superAdminUserId: number;
  /** 没有自定义群人设时采用的通知风格。 */
  readonly atmosphere: BotAtmosphere;
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
 * 与 AI agent 配置同住 config/dynamic/agent.json，但运行时仍按消费方分段加载：广告检测
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
export type AgentCapability = "text" | "summary" | "media" | "image" | "tts";

/** Google GenAI SDK 承载的一项能力配置。 */
export interface GoogleAgentCapabilityConfig {
  readonly provider: "google";
  readonly apiKey: string;
  /** 留空表示走 Google SDK 的官方端点。 */
  readonly baseUrl: string | undefined;
  /**
   * 附加到每个请求的请求头（generateContent 与 Interactions 两条路径都带），例如三方网关的
   * 鉴权头；留空表示不附加。每个值都按凭据进日志值级脱敏名单。
   */
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly model: string;
}

/** OpenAI SDK（含 OpenAI 兼容端点）承载的一项能力配置。 */
export interface OpenAiAgentCapabilityConfig {
  readonly provider: "openai";
  readonly apiKey: string;
  /** 留空表示走 OpenAI SDK 的官方端点。 */
  readonly baseUrl: string | undefined;
  /** OpenAI 协议不接受 headers，恒为 undefined。 */
  readonly headers: undefined;
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

/**
 * OpenAI 协议下语音合成的线协议。
 *
 * 同 OpenAiImageProtocol，这是请求体能力边界，不是模型枚举：`openai` 表示 OpenAI
 * audio/speech（官方 SDK，含兼容端点），`xai` 表示 xAI `POST /tts`（fetch，无模型名与风格
 * 指令字段）。新增时在这里和 aiChat/openai/speech.ts 的穷举分派同步增加一档。
 */
export type OpenAiSpeechProtocol = "openai" | "xai";

/** 三种语音合成配置共有的音色与每日额度。 */
interface AgentTtsVoiceQuota {
  /**
   * 原样交给实现包的音色：Google 为预置音色名或 AI Studio Voice design 生成的 `voice_` 音色 ID
   * （归属 api_key 所在项目、有效期一年，过期后须重新生成并替换），OpenAI 为 audio/speech 的
   * voice，xAI 为 `voice_id`。
   */
  readonly voice: string;
  /** 每个窗口拆分给 AI 与预留额度的总预算，正整数；缺省时为 TTS_DEFAULT_DAILY_LIMIT。 */
  readonly dailyLimit: number;
  /**
   * `/send` 与 cron 共用的独立额度，0～dailyLimit-1；AI 独立使用 dailyLimit - dailyReserveQuota，
   * 两边互不借用。daily_reserve_quota 缺省时为 TTS_DEFAULT_DAILY_RESERVE_QUOTA。
   */
  readonly dailyReserveQuota: number;
}

/** Google 语音合成配置（Interactions API）；不接受 speech_protocol 与 language。 */
export interface GoogleAgentTtsCapabilityConfig extends GoogleAgentCapabilityConfig, AgentTtsVoiceQuota {
  readonly speechProtocol: undefined;
  /** 基础朗读风格；部署字段 style 缺省时使用 TTS_DEFAULT_STYLE。 */
  readonly style: string;
  readonly language: undefined;
}

/** OpenAI audio/speech 协议的语音合成配置；风格经 `instructions` 发送。 */
export interface OpenAiAgentTtsCapabilityConfig extends OpenAiAgentCapabilityConfig, AgentTtsVoiceQuota {
  readonly speechProtocol: "openai";
  /** 基础朗读风格；部署字段 style 缺省时使用 TTS_DEFAULT_STYLE。 */
  readonly style: string;
  readonly language: undefined;
}

/**
 * xAI `POST /tts` 协议的语音合成配置。端点没有模型名与风格指令字段，部署配置出现 model 或
 * style 即拒绝，因此两项恒为 undefined。
 */
export interface XAiAgentTtsCapabilityConfig extends AgentTtsVoiceQuota {
  readonly provider: "openai";
  readonly apiKey: string;
  /** 留空表示走 xAI 官方端点 XAI_API_BASE_URL。 */
  readonly baseUrl: string | undefined;
  readonly headers: undefined;
  readonly model: undefined;
  readonly speechProtocol: "xai";
  readonly style: undefined;
  /** BCP-47 语言代码或 `auto`；部署字段 language 缺省时为 XAI_SPEECH_DEFAULT_LANGUAGE。 */
  readonly language: string;
}

/** 语音合成能力配置；字段集固定，各协议不适用的字段恒为 undefined。 */
export type AgentTtsCapabilityConfig =
  | GoogleAgentTtsCapabilityConfig
  | OpenAiAgentTtsCapabilityConfig
  | XAiAgentTtsCapabilityConfig;

/** 生图能力配置。 */
export type AgentImageCapabilityConfig =
  | GoogleAgentImageCapabilityConfig
  | OpenAiAgentImageCapabilityConfig;

/**
 * config/dynamic/agent.json 的 agent 段；三项对话核心能力必填且各自独立路由。
 * `text` 是带工具往返的群聊回复，`summary` 是无状态纯文本摘要，`media` 是视觉
 * 描述与语音转写，`image` 是生图，`tts` 是语音合成。
 */
export interface AgentDeploymentConfig {
  readonly text: AgentCapabilityConfig;
  readonly summary: AgentCapabilityConfig;
  readonly media: AgentCapabilityConfig;
  /** 缺省不影响 AI 对话，只是不注册生图工具。 */
  readonly image?: AgentImageCapabilityConfig;
  /** 缺省表示不提供语音工具；实现不支持时同样不会注册对应工具。 */
  readonly tts?: AgentTtsCapabilityConfig;
}

/**
 * 整份 config/dynamic/agent.json 严格解析后的两段快照；null 表示该段在文件里缺省
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

/**
 * 机器人默认头像的来源：本进程下载的 http(s) 直链，或已按运行时数据根解析成绝对路径的本机文件
 * （复原见 infra/telegram/avatar/restore.ts）。
 */
export type DefaultAvatarSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "path"; readonly path: string };

/**
 * config/dynamic/assets.json 解析并补齐缺省后的外部素材配置（解析见 packages/config/assets.ts）。
 * 五项各自独立；文件或字段缺省时取 consts/ui/assets.ts 的内置常量。
 */
export interface AssetConfig {
  /** 随机图片（`/h_image`）来源目录的绝对路径；相对写法已按运行时数据根解析。 */
  readonly randomHImageDirectory: string;
  /** 「未卜先知」内联结果的缩略图直链。 */
  readonly fortuneThumbnailUrl: string;
  /** 「概率论」内联结果的缩略图直链。 */
  readonly probabilityThumbnailUrl: string;
  /** gag 发言内联结果的缩略图直链。 */
  readonly gagThumbnailUrl: string;
  /** `/icon reset`、`/copy stop` 复原机器人默认头像时读取的直链或本机文件。 */
  readonly botDefaultAvatar: DefaultAvatarSource;
}

/** config/reload.ts 对六份可热重载部署文件的一轮读取。 */
export interface HotDeploymentConfigReads {
  /** assets.json；随机图片目录变化时已在读取阶段完成目录准备，失败记为 invalid。 */
  readonly assets: HotConfigRead<AssetConfig>;
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
  /** assets.json 的素材快照已替换；文件被删除时换回内置缺省。 */
  readonly assets: boolean;
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
  /** 相对项目根的路径，如 `config/dynamic/stickers.json`；直接出现在命令的拒绝文案里。 */
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
