import type { AiTextResult } from "./../../types/aiChat/provider";
import type { MediaInputEffect, MediaInputModalityState } from "../../types/states/mediaInputSupport";
/** 媒体视觉描述请求在错误日志里的调用名；供应商中立，两家实现包共用。 */
export const MEDIA_DESCRIPTION_ERROR_LABEL: string = "AI image understanding API";

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

/** 描述字数和输出 token 上限。 */
export const IMAGE_DESCRIPTION_MAX_CHARS: number = 125;
/** 贴纸和 GIF 短描述的最大字符数。 */
export const SHORT_MEDIA_DESCRIPTION_MAX_CHARS: number = 100;
/** Telegram 下载超时与单文件字节上限。只覆盖取回文件字节那一次 fetch。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS: number = 25_000;
/**
 * 取文件元数据（`getFile`）的独立超时预算，必须与下载分开计时：两步共用一个
 * deadline 时，一次 429 退避就能把下载的额度吃光，下载几乎立刻 abort，机器人
 * 对着一张明明能看的图装看不见。媒体描述这一路不带 invalidate signal，没有
 * 别的兜底。
 */
export const MEDIA_FILE_METADATA_TIMEOUT_MS: number = 10_000;
/** 单个媒体下载允许读入内存的最大字节数。 */
export const MEDIA_MAX_DOWNLOAD_BYTES: number = 16 * 1024 * 1024;
/** 非目录媒体描述的全局 LRU 上限。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 4_096;
/** 下载、转码、视觉 API 共用执行器的并发与排队硬顶。 */
export const MEDIA_DESCRIPTION_MAX_CONCURRENCY: number = 25;
/** 媒体执行器等待队列的硬顶，超出立即拒绝。 */
export const MEDIA_DESCRIPTION_MAX_PENDING: number = 75;

/**
 * 模态探测在连续瞬时失败后的首次退避时长（见
 * cache/workers/aiChat/mediaInputSupport.ts）。
 *
 * 这道退避挡的是「端点持续故障」：SDK 自己已经把首次加最多五次重试用完了，若
 * 下一条媒体立刻又下载一遍、再套一整轮请求，一个抽风的端点就能让每条群媒体都
 * 白付一次下载、转码和执行器槽位。
 */
export const MEDIA_PROBE_BACKOFF_BASE_MS: number = 30_000;
/**
 * 退避时长的上界。指数增长必须封顶：故障持续几小时时，无上界的退避等于把模态
 * 永久关掉，而那正是本状态机刻意不做的事（瞬时失败不得形成永久结论）。
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
 * media 模态从未探测过的初始状态，属 states/mediaInputSupport.ts。两种模态各取
 * 这一份共享只读对象；状态机只整体替换，不就地改写，因此共享不会串台。
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
