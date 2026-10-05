/**
 * AI agent 按能力选择 SDK 实现的唯一入口。
 *
 * config/dynamic/agent.json 的 text、summary、media、image、tts、web_search 各自声明 provider；这里
 * 只把 google/openai/anthropic 映射到实现包，不做运行时故障切换，也不从模型名或 base_url
 * 猜供应商。api_key 与端点同样来自该能力配置；启动总闸会在建立外部连接前完成
 * 严格校验。跨模块与生命周期约束见 docs/cn/04-invariants.md。
 *
 * 归属 AI 闲聊 Worker：所有调用方都在该线程上。各能力门面经 aiChat/providerLanes.ts 的配额 lane
 * 排队。
 */

import { claimOperatorTtsUsage, refundOperatorTtsUsage } from "./ai/ttsUsage";
import { ttsQuotaLimit } from "./ai/utils/ttsUsageWindow";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { openAiProvider } from "./openai";
import {
  aiProviderFacades,
  resetAiProviderFacades,
} from "../cache/workers/aiChat/providerScheduler";
import { geminiClientCache } from "../cache/workers/aiChat/gemini";
import { textGeminiContextCache } from "../cache/workers/aiChat/geminiContextCache";
import { resetMediaInputSupport } from "../cache/workers/aiChat/mediaInputSupport";
import { openAiClientCache } from "../cache/workers/aiChat/openai";
import { anthropicClientCache } from "../cache/workers/aiChat/anthropic";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig, requireAgentCapabilityConfig } from "../config/agent";
import { logger } from "../infra/logger";
import { pruneQuotaLanes, quotaRunnerFor } from "./providerLanes";
import type {
  AgentDeploymentConfig,
  AgentCapabilityConfig,
  AgentImageCapabilityConfig,
  AgentTtsCapabilityConfig,
} from "../types/config";
import type {
  AiChatProvider,
  AiImageProvider,
  AiImageRequest,
  AiMediaProvider,
  AiProviderTaskPriority,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiMeteredSpeechRequest,
  AiSpeechFacade,
  AiSpeechProvider,
  AiSummaryProvider,
  AiTextResult,
  AiTextRequest,
  AiTextProvider,
  AiVisionRequest,
  AiVoiceRequest,
  AiJsonRequest,
  AiStructuredTextProvider,
  AiWebSearchCapability,
  AiWebSearchFacade,
  AiWebSearchRequest,
  AiWebSearchResult,
} from "../types/aiChat/provider";
import type { GeneratedChatImage } from "../types/aiChat/imageGeneration";
import type { SpeechSynthesisAttempt, SynthesizedSpeech, TtsOperatorClaim } from "../types/aiChat/voiceMessage";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

/** provider 到实现包的穷举映射；扩展 AgentProvider 时编译器会要求同步补项。 */
const AI_CHAT_PROVIDERS: Readonly<Record<AgentCapabilityConfig["provider"], AiChatProvider>> = {
  google: geminiProvider,
  openai: openAiProvider,
  anthropic: anthropicProvider,
};

/** 下列 queueRejected* 是配额 lane 没有执行任务（队列已满或排队期间被取消）时各能力的结算值。 */
function queueRejectedReplyTurn(): AiReplyTurn {
  return {
    ok: false,
    text: null,
    functionCalls: [],
    webSearchCalls: 0,
    finishReason: "LOCAL_PROVIDER_QUEUE_FULL",
    finishMessage: "The local AI provider queue is full.",
    toolCallLimitHit: false,
  };
}

function queueRejectedTextResult(): AiTextResult {
  return { ok: false, retryable: false };
}

/** 生图按「这次没做出来」结算。 */
function queueRejectedImage(): null {
  return null;
}

function queueRejectedSpeechAttempt(): SpeechSynthesisAttempt {
  return { ok: false, reason: "synthesis failed" };
}

/** 一次都没检索。 */
function queueRejectedWebSearchResult(): AiWebSearchResult {
  return { ok: false, searchCalls: 0 };
}

/** runScheduled 的入参。 */
interface ScheduledRunParams<T> {
  readonly runner: PrioritizedBoundedTaskRunner;
  readonly priority: AiProviderTaskPriority;
  readonly signal: AbortSignal | undefined;
  /** 队列已满或排队期间被取消、任务没有执行时构造结算值。 */
  readonly fallback: () => T;
  readonly task: () => Promise<T>;
}

/** 把一次供应商调用交给配额 lane 排队；没轮到执行时按 fallback 结算，不把 undefined 泄漏给调用方。 */
async function runScheduled<T>({ runner, priority, signal, fallback, task }: ScheduledRunParams<T>): Promise<T> {
  const result: T | undefined = await runner.run(priority, task, signal);
  return result ?? fallback();
}

function createTextFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiTextProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    createReplySession(params: AiReplySessionParams): AiReplySession {
      const session: AiReplySession = provider.createReplySession(params);
      return {
        request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
          return runScheduled({
            runner,
            priority: "interactive",
            signal: params.signal,
            fallback: queueRejectedReplyTurn,
            task: (): Promise<AiReplyTurn> => session.request(request),
          });
        },
        appendToolOutputs: session.appendToolOutputs.bind(session),
      };
    },
  };
}

function createSummaryFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiSummaryProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    generateText(request: AiTextRequest): Promise<AiTextResult> {
      return runScheduled({
        runner,
        priority: "background",
        signal: request.signal,
        fallback: queueRejectedTextResult,
        task: (): Promise<AiTextResult> => provider.generateText(request),
      });
    },
  };
}

function createMediaFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig,
  priority: AiProviderTaskPriority
): AiMediaProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  const transcribeVoice: AiMediaProvider["transcribeVoice"] = provider.transcribeVoice;
  const describeVision: AiMediaProvider["describeVision"] = (
    request: AiVisionRequest
  ): Promise<AiTextResult> => runScheduled({
    runner,
    priority,
    signal: request.signal,
    fallback: queueRejectedTextResult,
    task: (): Promise<AiTextResult> => provider.describeVision(request),
  });
  if (transcribeVoice === undefined) return { name: provider.name, describeVision };
  return {
    name: provider.name,
    describeVision,
    transcribeVoice(request: AiVoiceRequest): Promise<AiTextResult> {
      return runScheduled({
        runner,
        priority,
        signal: request.signal,
        fallback: queueRejectedTextResult,
        task: (): Promise<AiTextResult> => transcribeVoice(request),
      });
    },
  };
}

/** 生图门面：交互优先排队；队列已满或被取消时按「这次没做出来」结算为 `null`。 */
function createImageFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiImageProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    generateImage(request: AiImageRequest): Promise<GeneratedChatImage | null> {
      return runScheduled<GeneratedChatImage | null>({
        runner,
        priority: "interactive",
        signal: request.signal,
        fallback: queueRejectedImage,
        task: (): Promise<GeneratedChatImage | null> => provider.generateImage(request),
      });
    },
  };
}

/**
 * 语音合成门面：请求经交互优先的配额闸门排队。`operator` 口径的请求在轮到执行、紧挨着
 * 发起供应商请求时登记每日计数（aiChat/ai/ttsUsage.ts 的 claimOperatorTtsUsage），超出本门面
 * 所属 `agent.tts` 配置的 operator 上限时不发请求，排队期间被取消或队列已满的不计数；供应商
 * 没给出音频（返回 null 或抛错）时凭登记凭据退还这一次。`ai` 口径由调用方自行预留与登记，
 * 门面直接合成。
 */
function createSpeechFacade(
  provider: AiChatProvider,
  config: AgentTtsCapabilityConfig
): AiSpeechFacade {
  const synthesizeSpeech: AiSpeechProvider["synthesizeSpeech"] = provider.synthesizeSpeech;
  // 选中的那一家没有这项能力时只交出名字：工具层据此不注册对应工具。
  if (synthesizeSpeech === undefined) return { name: provider.name };
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  const synthesize = async (request: AiMeteredSpeechRequest): Promise<SpeechSynthesisAttempt> => {
    let claim: TtsOperatorClaim | null = null;
    if (request.quota === "operator") {
      claim = claimOperatorTtsUsage(ttsQuotaLimit(config, "operator"));
      if (claim === null) return { ok: false, reason: "daily limit reached" };
    }
    let speech: SynthesizedSpeech | null = null;
    try {
      speech = await synthesizeSpeech(request);
    } finally {
      if (speech === null && claim !== null) refundOperatorTtsUsage(claim);
    }
    return speech === null ? { ok: false, reason: "synthesis failed" } : { ok: true, speech };
  };
  return {
    name: provider.name,
    synthesizeSpeech(request: AiMeteredSpeechRequest): Promise<SpeechSynthesisAttempt> {
      return runScheduled({
        runner,
        priority: "interactive",
        signal: request.signal,
        fallback: queueRejectedSpeechAttempt,
        task: (): Promise<SpeechSynthesisAttempt> => synthesize(request),
      });
    },
  };
}

/** createWebSearchFacade 的入参。 */
interface WebSearchFacadeParams {
  readonly provider: AiChatProvider;
  /** 绑定的能力；配额 lane 按它的配置归属。 */
  readonly capability: AiWebSearchCapability;
  readonly config: AgentCapabilityConfig;
  readonly priority: AiProviderTaskPriority;
}

/**
 * 联网检索门面：绑定能力后经配额闸门排队；队列已满或排队期间被取消时按一次都没检索的
 * 失败结算。
 */
function createWebSearchFacade({ provider, capability, config, priority }: WebSearchFacadeParams): AiWebSearchFacade {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    searchWeb(request: AiWebSearchRequest): Promise<AiWebSearchResult> {
      return runScheduled({
        runner,
        priority,
        signal: request.signal,
        fallback: queueRejectedWebSearchResult,
        task: (): Promise<AiWebSearchResult> => provider.searchWeb(capability, request),
      });
    },
  };
}

/** text 能力的结构化 JSON 生成门面：按后台优先级排队，队列已满或被取消时按不可重试失败返回。 */
function createStructuredTextFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiStructuredTextProvider {
  const runner: PrioritizedBoundedTaskRunner = quotaRunnerFor(config);
  return {
    name: provider.name,
    generateJson(request: AiJsonRequest): Promise<AiTextResult> {
      return runScheduled({
        runner,
        priority: "background",
        signal: request.signal,
        fallback: queueRejectedTextResult,
        task: (): Promise<AiTextResult> => provider.generateJson(request),
      });
    },
  };
}

/** 带工具往返的群聊正文能力；真实模型请求经过交互优先的配额闸门。 */
export function textAiProvider(): AiTextProvider {
  if (aiProviderFacades.text !== undefined) return aiProviderFacades.text;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiTextProvider = createTextFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.text = facade;
  return facade;
}

/** 记忆压缩与贴纸包简介的无状态摘要能力；固定使用后台等待额度。 */
export function summaryAiProvider(): AiSummaryProvider {
  if (aiProviderFacades.summary !== undefined) return aiProviderFacades.summary;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("summary");
  const facade: AiSummaryProvider = createSummaryFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.summary = facade;
  return facade;
}

/** 视觉描述与语音转写能力；贴纸目录可显式选择后台优先级。 */
export function mediaAiProvider(
  priority: AiProviderTaskPriority = "interactive"
): AiMediaProvider {
  const cached: AiMediaProvider | undefined = priority === "interactive"
    ? aiProviderFacades.media
    : aiProviderFacades.mediaBackground;
  if (cached !== undefined) return cached;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("media");
  const facade: AiMediaProvider = createMediaFacade(
    AI_CHAT_PROVIDERS[config.provider],
    config,
    priority
  );
  if (priority === "interactive") aiProviderFacades.media = facade;
  else aiProviderFacades.mediaBackground = facade;
  return facade;
}

/** optionalCapabilityFacade 的入参。 */
interface OptionalCapabilityFacadeParams<TCapability extends "image" | "tts" | "webSearch", TFacade> {
  /** AgentDeploymentConfig 上的能力字段名，也是记忆化槽位名。 */
  readonly capability: TCapability;
  /** 当前缓存值；`undefined` 专表「还没问过」。 */
  readonly cached: TFacade | null | undefined;
  /** 配置齐全时以该能力自己的配置构造门面。 */
  readonly create: (config: NonNullable<AgentDeploymentConfig[TCapability]>) => TFacade;
  /** 写回记忆化槽位；null 同样要写。 */
  readonly store: (facade: TFacade | null) => void;
}

/**
 * 可缺席能力（image、tts、web_search）的门面记忆化：缺配置时把 `null` 也缓存下来。
 * `undefined` 专表「还没问过」，`null` 表「问过、没配」，两者严格分开缓存。
 */
function optionalCapabilityFacade<TCapability extends "image" | "tts" | "webSearch", TFacade>({
  capability,
  cached,
  create,
  store,
}: OptionalCapabilityFacadeParams<TCapability, TFacade>): TFacade | null {
  if (cached !== undefined) return cached;
  const config: AgentDeploymentConfig[TCapability] = getAgentDeploymentConfig()[capability];
  if (config === undefined) {
    store(null);
    return null;
  }
  const facade: TFacade = create(config);
  store(facade);
  return facade;
}

/** 生图能力；未配置时不注册对应工具。 */
export function imageAiProvider(): AiImageProvider | null {
  return optionalCapabilityFacade<"image", AiImageProvider>({
    capability: "image",
    cached: aiProviderFacades.image,
    create: (config: AgentImageCapabilityConfig): AiImageProvider =>
      createImageFacade(AI_CHAT_PROVIDERS[config.provider], config),
    store: (facade: AiImageProvider | null): void => { aiProviderFacades.image = facade; },
  });
}

/** 带每日计数的语音合成能力；缺配置时不注册对应工具。 */
export function ttsAiProvider(): AiSpeechFacade | null {
  return optionalCapabilityFacade<"tts", AiSpeechFacade>({
    capability: "tts",
    cached: aiProviderFacades.tts,
    create: (config: AgentTtsCapabilityConfig): AiSpeechFacade =>
      createSpeechFacade(AI_CHAT_PROVIDERS[config.provider], config),
    store: (facade: AiSpeechFacade | null): void => { aiProviderFacades.tts = facade; },
  });
}

/**
 * web_search 能力的联网检索执行器（交互优先：回复在等它）；未配置时回复改挂 text 模型的内建
 * 检索，cron 摘要改用 textWebSearchAiProvider。
 */
export function webSearchAiProvider(): AiWebSearchFacade | null {
  return optionalCapabilityFacade<"webSearch", AiWebSearchFacade>({
    capability: "webSearch",
    cached: aiProviderFacades.webSearch,
    create: (config: AgentCapabilityConfig): AiWebSearchFacade => createWebSearchFacade({
      provider: AI_CHAT_PROVIDERS[config.provider],
      capability: "web_search",
      config,
      priority: "interactive",
    }),
    store: (facade: AiWebSearchFacade | null): void => { aiProviderFacades.webSearch = facade; },
  });
}

/** 用 text 模型执行的联网检索（后台优先级）：没配 web_search 时 cron 摘要的检索段用它。 */
export function textWebSearchAiProvider(): AiWebSearchFacade {
  if (aiProviderFacades.textWebSearch !== undefined) return aiProviderFacades.textWebSearch;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiWebSearchFacade = createWebSearchFacade({
    provider: AI_CHAT_PROVIDERS[config.provider],
    capability: "text",
    config,
    priority: "background",
  });
  aiProviderFacades.textWebSearch = facade;
  return facade;
}

/** text 能力的结构化 JSON 生成（cron 摘要组稿）。 */
export function structuredTextAiProvider(): AiStructuredTextProvider {
  if (aiProviderFacades.structuredText !== undefined) return aiProviderFacades.structuredText;
  const config: AgentCapabilityConfig = requireAgentCapabilityConfig("text");
  const facade: AiStructuredTextProvider = createStructuredTextFacade(AI_CHAT_PROVIDERS[config.provider], config);
  aiProviderFacades.structuredText = facade;
  return facade;
}

/**
 * 启动诊断：能力配置齐全、结构校验也过了，但选中的那一家**根本没有**这项能力
 * （工具不挂、语音不转写）。这不是错误配置，不拒绝启动，只记 warn。
 *
 * 在 AI Worker 初始化与每次 agent 配置热重载后各调用一次，逐轮回复不重复记录。
 */
export function reportUnimplementedAgentCapabilities(): void {
  const config: AgentDeploymentConfig = getAgentDeploymentConfig();
  const tts: AgentTtsCapabilityConfig | undefined = config.tts;
  if (tts !== undefined && AI_CHAT_PROVIDERS[tts.provider].synthesizeSpeech === undefined) {
    logger.warn(
      `Speech synthesis stays unavailable: $.agent.tts selects the "${tts.provider}" provider, ` +
      "which does not implement it. The send_voice tool will not be registered."
    );
  }
  if (AI_CHAT_PROVIDERS[config.media.provider].transcribeVoice === undefined) {
    logger.warn(
      `Voice transcription stays unavailable: $.agent.media selects the "${config.media.provider}" provider, ` +
      "which does not implement it. Voice messages will fall back to a placeholder in the transcript."
    );
  }
}

/**
 * 接管主线程热重载投递的 agent 对话能力快照（见 workers/aiChat/configReload.ts）。
 *
 * 整体替换本线程 holder 后丢弃按旧快照建立的能力门面与三家 SDK 客户端，下一次
 * 取用按新快照重建；在途请求继续持有旧门面与旧客户端直至结算。同一协议、端点
 * 与凭据的配额 lane 原样保留，并发额度跨重载延续；不再被任何能力引用的 lane
 * 从表中摘除。media 能力变化时两种输入模态回到未探测状态；text 能力变化时丢弃
 * Gemini 回复共用显式缓存的登记表，下一次回复按新客户端重新扫描。
 */
export function reloadAgentDeploymentConfig(config: AgentDeploymentConfig): void {
  const previous: AgentDeploymentConfig = getAgentDeploymentConfig();
  const previousMedia: AgentCapabilityConfig = previous.media;
  const previousText: AgentCapabilityConfig = previous.text;
  adoptAgentDeploymentConfig(config);
  resetAiProviderFacades();
  geminiClientCache.current = null;
  openAiClientCache.current = null;
  anthropicClientCache.current = null;
  if (!Bun.deepEquals(previousText, config.text)) textGeminiContextCache.current = null;
  pruneQuotaLanes(config);
  if (!Bun.deepEquals(previousMedia, config.media)) resetMediaInputSupport();
  reportUnimplementedAgentCapabilities();
}
