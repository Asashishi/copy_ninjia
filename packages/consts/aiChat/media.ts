/** 图片、贴纸与 GIF 描述使用的视觉模型。 */
export const GEMINI_MEDIA_MODEL: string = "gemini-3.5-flash-lite";

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
/** 单次媒体描述请求允许的最大输出 token。 */
export const MEDIA_DESCRIPTION_MAX_TOKENS: number = 8192;
/** Telegram 下载超时与单文件字节上限。只覆盖取回文件字节那一次 fetch。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS: number = 25_000;
/**
 * 取文件元数据（`getFile`）的独立超时预算，必须与下载分开计时：两步共用一个
 * deadline 时，一次 429 退避就能把下载的额度吃光，下载几乎立刻 abort，机器人
 * 对着一张明明能看的图装看不见。这里比下载短——它只是一次小的 Bot API 往返，
 * 长尾全部来自共享 throttler 与 autoRetry 的退避，不值得占满整条描述流水线的
 * 执行槽（媒体描述那一路不带 invalidate signal，没有别的兜底）。
 */
export const MEDIA_FILE_METADATA_TIMEOUT_MS: number = 10_000;
/** 单个媒体下载允许读入内存的最大字节数。 */
export const MEDIA_MAX_DOWNLOAD_BYTES: number = 16 * 1024 * 1024;
/** 非目录媒体描述的全局 LRU 上限。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 1_500;
/** 下载、转码、视觉 API 共用执行器的并发与排队硬顶。 */
export const MEDIA_DESCRIPTION_MAX_CONCURRENCY: number = 75;
/** 媒体执行器等待队列的硬顶，超出立即拒绝。 */
export const MEDIA_DESCRIPTION_MAX_PENDING: number = 150;
