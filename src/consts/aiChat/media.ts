/** 图片、贴纸与 GIF 描述使用的视觉模型。 */
export const GEMINI_MEDIA_MODEL: string = "gemini-3.1-flash-lite";

export const IMAGE_PENDING_PLACEHOLDER: string = "[图片：识别中]";
export const IMAGE_FALLBACK_PLACEHOLDER: string = "[图片：解析失败，请无视此消息]";
export const STICKER_PENDING_PLACEHOLDER: string = "[贴纸：识别中]";
export const ANIMATION_PENDING_PLACEHOLDER: string = "[GIF：识别中]";
export const ANIMATION_FALLBACK_PLACEHOLDER: string = "[GIF：解析失败，请无视此消息]";

/** 描述字数和输出 token 上限。 */
export const IMAGE_DESCRIPTION_MAX_CHARS: number = 125;
export const SHORT_MEDIA_DESCRIPTION_MAX_CHARS: number = 100;
export const MEDIA_DESCRIPTION_MAX_TOKENS: number = 8192;
/** Telegram 下载超时与单文件字节上限。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS: number = 25_000;
export const MEDIA_MAX_DOWNLOAD_BYTES: number = 8 * 1024 * 1024;
/** 非目录媒体描述的全局 LRU 上限。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 1500;
/** 下载、转码、视觉 API 共用执行器的并发与排队硬顶。 */
export const MEDIA_DESCRIPTION_MAX_CONCURRENCY: number = 35;
export const MEDIA_DESCRIPTION_MAX_PENDING: number = 75;
