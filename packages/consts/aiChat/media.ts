import type { AiTextResult } from "./../../types/aiChat/provider";
import type { MediaInputEffect, MediaInputModalityState } from "../../types/states/mediaInputSupport";
/** 媒体视觉描述请求在错误日志里的调用名；供应商中立，各家实现包共用。 */
export const MEDIA_DESCRIPTION_ERROR_LABEL: string = "AI image understanding API";

/** 供应商错误中属于单份媒体格式或内容的证据；错误分类器遇到这些词不形成模态结论。 */
export const MEDIA_INPUT_FILE_ERROR_PATTERN: RegExp =
  /\b(?:formats?|mime|codecs?|encodings?|corrupt(?:ed|ion)?|malformed|damaged|decod(?:e|ing)|resolution|dimensions?|sizes?|bytes?|base64|urls?)\b/i;

/** 媒体错误分类器所需的能力边界证据；模型、端点、模态或明确的媒体输入，普通 media type 不构成证据。 */
export const MEDIA_INPUT_CAPABILITY_PATTERN: RegExp =
  /\b(?:model|endpoint|deployment|modalit(?:y|ies))\b|\b(?:image|vision|audio|voice|media)[ _-]?inputs?\b|\binput_(?:image|audio)\b/i;

/** 图片视觉描述尚未落定时进入转录的占位。 */
export const IMAGE_PENDING_PLACEHOLDER: string = "[图片：识别中]";
/** 图片视觉描述最终失败时替换进转录的占位。 */
export const IMAGE_FALLBACK_PLACEHOLDER: string = "[图片：解析失败，请无视此消息]";
/** 贴纸视觉描述尚未落定时进入转录的占位。 */
export const STICKER_PENDING_PLACEHOLDER: string = "[贴纸：识别中]";
/** 贴纸视觉描述最终失败时替换进转录的占位。 */
export const STICKER_FALLBACK_PLACEHOLDER: string = "[贴纸：解析失败，请无视此消息]";
/** GIF 视觉描述尚未落定时进入转录的占位。 */
export const ANIMATION_PENDING_PLACEHOLDER: string = "[GIF：识别中]";
/** GIF 视觉描述最终失败时替换进转录的占位。 */
export const ANIMATION_FALLBACK_PLACEHOLDER: string = "[GIF：解析失败，请无视此消息]";

/** 图片视觉描述的最大字符数；输出 token 上限见 consts/aiChat/{gemini,openai}.ts。 */
export const IMAGE_DESCRIPTION_MAX_CHARS: number = 125;
/** 贴纸和 GIF 短描述的最大字符数。 */
export const SHORT_MEDIA_DESCRIPTION_MAX_CHARS: number = 100;
/** Telegram 文件下载请求（从发出到读完）的超时；只覆盖取回文件字节那一次 fetch。getFile 的超时见 MEDIA_FILE_METADATA_TIMEOUT_MS，字节上限见 MEDIA_MAX_DOWNLOAD_BYTES。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS: number = 60_000;
/**
 * 取文件元数据（`getFile`）的独立超时预算，与下载分开计时。取消信号
 * （回复代际失效）同时合入两段超时，见 infra/telegram/fileDownload.ts。
 */
export const MEDIA_FILE_METADATA_TIMEOUT_MS: number = 15_000;
/**
 * 内联媒体请求的整体字节预算：取 Gemini 官方对内联数据整个请求（提示词、system
 * 指令与 base64 字节合计）的上限，各家实现共用同一份媒体字节、按这一上限取。Anthropic 的单图
 * 上限更低，超出的那一份由端点按单份媒体拒绝，不改变模态结论。
 * 所属模块：本文件与 consts/aiChat/voice.ts 的字节上限推导。
 */
export const MEDIA_INLINE_REQUEST_MAX_BYTES: number = 20_000_000;
/** 内联请求里留给提示词、system 指令与请求封装的字节余量；所属模块同 MEDIA_INLINE_REQUEST_MAX_BYTES。 */
export const MEDIA_INLINE_PROMPT_RESERVE_BYTES: number = 1_000_000;
/**
 * 单张视觉图片（下载与转码后）允许读入内存并内联进请求的最大字节数，也是下载
 * 与 photo 档位选择的上限。按 base64 编码后加 MEDIA_INLINE_PROMPT_RESERVE_BYTES
 * 恰好不超过 MEDIA_INLINE_REQUEST_MAX_BYTES 推导。所属模块：
 * aiChat/ai/telegramImage.ts、infra/telegram/workerRequests.ts 与 libs/telegramImage.ts。
 */
export const MEDIA_MAX_DOWNLOAD_BYTES: number =
  Math.floor((MEDIA_INLINE_REQUEST_MAX_BYTES - MEDIA_INLINE_PROMPT_RESERVE_BYTES) / 4) * 3;
/** 非目录媒体描述的全局 LRU 上限。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 4_096;
/** 下载、转码、视觉 API 共用执行器的并发上限；排队上限见 MEDIA_DESCRIPTION_MAX_PENDING。 */
export const MEDIA_DESCRIPTION_MAX_CONCURRENCY: number = 32;
/** 媒体执行器排队与两种模态冷探测等待合计的硬顶，超出立即拒绝。 */
export const MEDIA_DESCRIPTION_MAX_PENDING: number = 256;

/**
 * 模态探测在连续瞬时失败后的首次退避时长（见
 * cache/workers/aiChat/mediaInputSupport.ts）。退避期间的媒体请求得到
 * MEDIA_BACKOFF_RESULT。
 */
export const MEDIA_PROBE_BACKOFF_BASE_MS: number = 30_000;
/**
 * 退避时长的上界；瞬时失败不形成永久结论。
 */
export const MEDIA_PROBE_BACKOFF_MAX_MS: number = 10 * 60_000;
/**
 * 连续瞬时失败计数的封顶，只用于选退避档位。按 `MEDIA_PROBE_BACKOFF_BASE_MS
 * × 2^(n-1)` 换算退避时长，超过本值不再继续增长；必须选到刚好使换算结果达到
 * MEDIA_PROBE_BACKOFF_MAX_MS 的档位，改动其中一个常量需要一并重算另一个。
 */
export const MEDIA_PROBE_MAX_TRANSIENT_FAILURES: number = 6;

/** AI 模态已关闭时的共享不可重试结果，不产生新的模态故障。 */
export const MEDIA_CLOSED_RESULT: Readonly<AiTextResult> = { ok: false, retryable: false };

/** AI 模态探测退避期间的共享可重试结果。 */
export const MEDIA_BACKOFF_RESULT: Readonly<AiTextResult> = { ok: false, retryable: true };

/** AI 媒体执行器拒绝接纳时的共享可重试结果。 */
export const MEDIA_TASK_REJECTED_RESULT: Readonly<AiTextResult> = { ok: false, retryable: true };

/** AI 媒体主动取消时的共享不可重试结果，不归因于供应商。 */
export const MEDIA_CANCELLED_RESULT: Readonly<AiTextResult> = { ok: false, retryable: false };

/**
 * media 模态从未探测过的初始状态，属 cache/workers/aiChat/mediaInputSupport.ts。两种模态各取
 * 这一份共享只读对象；状态机只整体替换，不就地改写。
 * 配置代次 0 是第一代，agent.json 热重载替换 media 能力时由 resetMediaInputSupport
 * 递增。
 */
export const INITIAL_MEDIA_INPUT_STATE: Readonly<MediaInputModalityState> = {
  support: "unknown",
  transientFailures: 0,
  nextProbeAt: 0,
  configGeneration: 0,
};

/**
 * 模态支持度状态机无需副作用时共用的空效果表；只读，任何转移都不得向它追加。
 * 所属模块：states/mediaInputSupport.ts。
 */
export const NO_MEDIA_INPUT_EFFECTS: readonly MediaInputEffect[] = [];
