/**
 * AI agent 按能力选择 SDK 实现的唯一入口。
 *
 * config/agent.json 的 text、summary、media、image、song 各自声明 provider；这里
 * 只把 google/openai 映射到实现包，不做运行时故障切换，也不从模型名或 base_url
 * 猜供应商。api_key 与端点同样来自该能力配置；启动总闸会在建立外部连接前完成
 * 严格校验。跨模块与生命周期约束见 docs/cn/04-invariants.md。
 *
 * 归属 AI 闲聊 Worker：所有调用方都在该线程上。
 */

import { geminiProvider } from "./gemini";
import { openAiProvider } from "./openai";
import {
  aiProviderFacades,
  aiProviderQuotaLanes,
} from "../cache/workers/aiChat/providerScheduler";
import { getAgentDeploymentConfig } from "../config/agent";
import {
  AI_PROVIDER_BACKGROUND_MAX_PENDING,
  AI_PROVIDER_INTERACTIVE_BURST,
  AI_PROVIDER_MAX_CONCURRENT,
  AI_PROVIDER_MAX_PENDING,
} from "../consts/aiChat/provider";
import { logger } from "../infra/logger";
import { createPrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { AgentDeploymentConfig } from "../types/config";
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
  AiSongRequest,
  AiSongProvider,
  AiSummaryProvider,
  AiTextResult,
  AiTextRequest,
  AiTextProvider,
  AiVisionRequest,
  AiVoiceRequest,
} from "../types/aiChat/provider";
import type { AiProviderQuotaLane } from "../types/aiChat/providerScheduler";
import type { GeneratedChatImage } from "../types/aiChat/imageGeneration";
import type { GeneratedChatSong } from "../types/aiChat/songGeneration";
import type { AgentCapability, AgentCapabilityConfig } from "../types/config";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";

/** provider 到实现包的穷举映射；扩展 AgentProvider 时编译器会要求同步补项。 */
const AI_CHAT_PROVIDERS: Readonly<Record<AgentCapabilityConfig["provider"], AiChatProvider>> = {
  google: geminiProvider,
  openai: openAiProvider,
};

/**
 * 按能力配置解析 provider；不做凭据或故障回退。
 *
 * 内部保留完整实现，返回类型由下面五个导出各自收窄：映射穷举要的是「这一家把
 * 五项能力都装配齐了」，调用点要的是「这一次只许用这一项」，两件事分开表达。
 */
function resolveCapability(capability: AgentCapability): AiChatProvider {
  const config: AgentCapabilityConfig | undefined = getAgentDeploymentConfig()[capability];
  if (config === undefined) {
    throw new Error(`Agent capability "${capability}" is not configured.`);
  }
  return AI_CHAT_PROVIDERS[config.provider];
}

function capabilityConfig(capability: AgentCapability): AgentCapabilityConfig {
  const config: AgentCapabilityConfig | undefined = getAgentDeploymentConfig()[capability];
  if (config === undefined) {
    throw new Error(`Agent capability "${capability}" is not configured.`);
  }
  return config;
}

/**
 * 以供应商协议、端点与凭据识别真实配额归属。模型名刻意不参与：同一账号下的
 * 多模型通常仍共享项目级额度，拆开会让总并发悄悄倍增。
 */
function quotaRunnerFor(config: AgentCapabilityConfig): PrioritizedBoundedTaskRunner {
  for (const lane of aiProviderQuotaLanes) {
    if (
      lane.provider === config.provider &&
      lane.baseUrl === config.baseUrl &&
      lane.apiKey === config.apiKey
    ) return lane.runner;
  }
  const lane: AiProviderQuotaLane = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    runner: createPrioritizedBoundedTaskRunner({
      maxConcurrent: AI_PROVIDER_MAX_CONCURRENT,
      maxPending: AI_PROVIDER_MAX_PENDING,
      maxBackgroundPending: AI_PROVIDER_BACKGROUND_MAX_PENDING,
      interactiveBurst: AI_PROVIDER_INTERACTIVE_BURST,
    }),
  };
  aiProviderQuotaLanes.push(lane);
  return lane.runner;
}

function scheduleProviderTask<T>(
  runner: PrioritizedBoundedTaskRunner,
  priority: AiProviderTaskPriority,
  task: () => Promise<T>
): Promise<T | undefined> {
  return runner.run(priority, task);
}

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
        async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
          const result: AiReplyTurn | undefined = await scheduleProviderTask(
            runner,
            "interactive",
            (): Promise<AiReplyTurn> => session.request(request)
          );
          return result ?? queueRejectedReplyTurn();
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
    async generateText(request: AiTextRequest): Promise<AiTextResult> {
      const result: AiTextResult | undefined = await scheduleProviderTask(
        runner,
        "background",
        (): Promise<AiTextResult> => provider.generateText(request)
      );
      return result ?? { ok: false, retryable: false };
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
  const describeVision: AiMediaProvider["describeVision"] = async (
    request: AiVisionRequest
  ): Promise<AiTextResult> => {
    const result: AiTextResult | undefined = await scheduleProviderTask(
      runner,
      priority,
      (): Promise<AiTextResult> => provider.describeVision(request)
    );
    return result ?? { ok: false, retryable: false };
  };
  if (transcribeVoice === undefined) return { name: provider.name, describeVision };
  return {
    name: provider.name,
    describeVision,
    async transcribeVoice(request: AiVoiceRequest): Promise<AiTextResult> {
      const result: AiTextResult | undefined = await scheduleProviderTask(
        runner,
        priority,
        (): Promise<AiTextResult> => transcribeVoice(request)
      );
      return result ?? { ok: false, retryable: false };
    },
  };
}

/**
 * 把一次「生成一件媒体」的调用裹进交互优先的配额闸门。
 *
 * 队列满时 runner 返回 undefined，这里统一归一成 `null`——生图与生歌的调用方都
 * 按「这次没做出来」处理，不能把队列拒绝泄漏成一个 undefined 让工具层再猜一次。
 */
function scheduleMediaGeneration<TRequest, TResult>(
  runner: PrioritizedBoundedTaskRunner,
  generate: (request: TRequest) => Promise<TResult | null>
): (request: TRequest) => Promise<TResult | null> {
  return async (request: TRequest): Promise<TResult | null> => {
    const result: TResult | null | undefined = await scheduleProviderTask(
      runner,
      "interactive",
      (): Promise<TResult | null> => generate(request)
    );
    return result ?? null;
  };
}

function createImageFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiImageProvider {
  return {
    name: provider.name,
    generateImage: scheduleMediaGeneration<AiImageRequest, GeneratedChatImage>(
      quotaRunnerFor(config),
      (request: AiImageRequest): Promise<GeneratedChatImage | null> =>
        provider.generateImage(request)
    ),
  };
}

function createSongFacade(
  provider: AiChatProvider,
  config: AgentCapabilityConfig
): AiSongProvider {
  const generateSong: AiSongProvider["generateSong"] = provider.generateSong;
  // 选中的那一家没有这项能力时只交出名字：工具层据此不注册对应工具。
  if (generateSong === undefined) return { name: provider.name };
  return {
    name: provider.name,
    generateSong: scheduleMediaGeneration<AiSongRequest, GeneratedChatSong>(
      quotaRunnerFor(config),
      (request: AiSongRequest): Promise<GeneratedChatSong | null> =>
        generateSong(request)
    ),
  };
}

/** 带工具往返的群聊正文能力；真实模型请求经过交互优先的配额闸门。 */
export function textAiProvider(): AiTextProvider {
  if (aiProviderFacades.text !== undefined) return aiProviderFacades.text;
  const config: AgentCapabilityConfig = capabilityConfig("text");
  const facade: AiTextProvider = createTextFacade(resolveCapability("text"), config);
  aiProviderFacades.text = facade;
  return facade;
}

/** 记忆压缩与贴纸包简介的无状态摘要能力；固定使用后台等待额度。 */
export function summaryAiProvider(): AiSummaryProvider {
  if (aiProviderFacades.summary !== undefined) return aiProviderFacades.summary;
  const config: AgentCapabilityConfig = capabilityConfig("summary");
  const facade: AiSummaryProvider = createSummaryFacade(resolveCapability("summary"), config);
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
  const config: AgentCapabilityConfig = capabilityConfig("media");
  const facade: AiMediaProvider = createMediaFacade(resolveCapability("media"), config, priority);
  if (priority === "interactive") aiProviderFacades.media = facade;
  else aiProviderFacades.mediaBackground = facade;
  return facade;
}

/**
 * 可缺席能力的门面记忆化：缺配置时把 `null` 也缓存下来。
 *
 * 缓存 null 与缓存门面同样重要——不缓存的话，每次工具注册都要重新读一遍部署
 * 配置去确认「还是没配」。`undefined` 因此专表「还没问过」，与「问过、没有」
 * 严格分开。
 */
interface OptionalCapabilityFacadeParams<TFacade> {
  /** 部署配置里的能力键，也是记忆化槽位名。 */
  readonly capability: "image" | "song";
  /** 当前缓存值；`undefined` 专表「还没问过」。 */
  readonly cached: TFacade | null | undefined;
  /** 配置齐全时构造门面。 */
  readonly create: (config: AgentCapabilityConfig) => TFacade;
  /** 写回记忆化槽位；null 同样要写。 */
  readonly store: (facade: TFacade | null) => void;
}

function optionalCapabilityFacade<TFacade>({
  capability,
  cached,
  create,
  store,
}: OptionalCapabilityFacadeParams<TFacade>): TFacade | null {
  if (cached !== undefined) return cached;
  if (getAgentDeploymentConfig()[capability] === undefined) {
    store(null);
    return null;
  }
  const facade: TFacade = create(capabilityConfig(capability));
  store(facade);
  return facade;
}

/** 生图能力；未配置时不注册对应工具。 */
export function imageAiProvider(): AiImageProvider | null {
  return optionalCapabilityFacade<AiImageProvider>({
    capability: "image",
    cached: aiProviderFacades.image,
    create: (config: AgentCapabilityConfig): AiImageProvider =>
      createImageFacade(resolveCapability("image"), config),
    store: (facade: AiImageProvider | null): void => { aiProviderFacades.image = facade; },
  });
}

/** 生歌能力；缺配置时不注册对应工具。 */
export function songAiProvider(): AiSongProvider | null {
  return optionalCapabilityFacade<AiSongProvider>({
    capability: "song",
    cached: aiProviderFacades.song,
    create: (config: AgentCapabilityConfig): AiSongProvider =>
      createSongFacade(resolveCapability("song"), config),
    store: (facade: AiSongProvider | null): void => { aiProviderFacades.song = facade; },
  });
}

/**
 * 启动诊断：能力配置齐全、结构校验也过了，但选中的那一家**根本没有**这项能力。
 *
 * 这不是错误配置，因此不拒绝启动——功能行为是正确的（工具不挂、语音不转写）。
 * 但没有这行诊断，部署者只能从「机器人为什么不会唱歌」反推到「我给 song 选的
 * provider 没实现它」，中间隔着整条工具装配链路。
 *
 * 在 AI Worker 初始化时调用一次即可：能力配置在进程生命周期内不变，逐轮回复重复
 * 记录只会把真正的故障淹掉。
 */
export function reportUnimplementedAgentCapabilities(): void {
  const config: AgentDeploymentConfig = getAgentDeploymentConfig();
  const song: AgentCapabilityConfig | undefined = config.song;
  if (song !== undefined && AI_CHAT_PROVIDERS[song.provider].generateSong === undefined) {
    logger.error(
      `Song generation stays unavailable: $.agent.song selects the "${song.provider}" provider, ` +
      "which does not implement it. The generate_song tool will not be registered."
    );
  }
  if (AI_CHAT_PROVIDERS[config.media.provider].transcribeVoice === undefined) {
    logger.error(
      `Voice transcription stays unavailable: $.agent.media selects the "${config.media.provider}" provider, ` +
      "which does not implement it. Voice messages will fall back to a placeholder in the transcript."
    );
  }
}
