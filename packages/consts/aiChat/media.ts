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
 * 对着一张明明能看的图装看不见。这里比下载短——它只是一次小的 Bot API 往返，
 * 长尾全部来自主线程自适应 429 队列，不值得占满整条描述流水线的
 * 执行槽（媒体描述那一路不带 invalidate signal，没有别的兜底）。
 */
export const MEDIA_FILE_METADATA_TIMEOUT_MS: number = 10_000;
/** 单个媒体下载允许读入内存的最大字节数。 */
export const MEDIA_MAX_DOWNLOAD_BYTES: number = 16 * 1024 * 1024;
/** 非目录媒体描述的全局 LRU 上限。 */
export const MEDIA_DESCRIPTION_CACHE_MAX: number = 1_500;
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
 * 白付一次下载、转码和执行器槽位。取 30 秒是因为常见的 429/5xx 抖动在这个量级
 * 内多半已经恢复，而群里几十秒不认图的观感损失可以接受。
 */
export const MEDIA_PROBE_BACKOFF_BASE_MS: number = 30_000;
/**
 * 退避时长的上界。指数增长必须封顶：故障持续几小时时，无上界的退避等于把模态
 * 永久关掉，而那正是本状态机刻意不做的事（瞬时失败不得形成永久结论）。
 */
export const MEDIA_PROBE_BACKOFF_MAX_MS: number = 10 * 60_000;
/**
 * 连续瞬时失败计数的封顶。计数只用于选退避档位，取 6 是因为
 * `30s × 2^(n-1)` 到第 6 档（960 秒）才真正撞上 MEDIA_PROBE_BACKOFF_MAX_MS 的
 * 十分钟上界——封得更低，那个上界就永远不会生效，读代码的人会以为退避能涨到
 * 十分钟而实际最多八分钟。到顶之后档位不再变化，数值本身没有继续增长的意义，
 * 留着只会让一个永远不清零的整数无声地涨下去。
 */
export const MEDIA_PROBE_MAX_TRANSIENT_FAILURES: number = 6;
