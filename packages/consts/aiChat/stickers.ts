/** getStickerSet 失败后的短期负缓存；到期后同进程可重新请求。 */
export const STICKER_SET_FAILURE_RETRY_MS: number = 60_000;

/** 一轮回复最多发送一枚贴纸。 */
export const MAX_STICKERS_PER_REPLY: number = 1;
/** 部署配置最多允许五个贴纸包，启动预检会拒绝超出的配置。 */
export const MAX_CONFIGURED_STICKER_PACKS: number = 5;
/** Telegram 贴纸包 short name 的运行时校验规则。 */
export const STICKER_PACK_NAME_PATTERN: RegExp = /^[A-Za-z0-9_]{1,64}$/;
/** 一轮最多查看五个不同贴纸包；同一包由执行侧保证只能查看一次。 */
export const MAX_STICKER_PACK_VIEWS_PER_REPLY: number = MAX_CONFIGURED_STICKER_PACKS;

/** view_sticker_pack 展示「正在选择贴纸」的基础停顿和随机抖动。 */
export const STICKER_CHOOSE_DELAY_BASE_MS: number = 1_500;
/** 贴纸选择停顿额外增加的随机时间上界。 */
export const STICKER_CHOOSE_DELAY_JITTER_MS: number = 3_500;

/** 贴纸目录单次 AI 调用失败后的跨请求退避序列。 */
export const STICKER_CATALOG_RETRY_DELAYS_MS: readonly number[] = Object.freeze([15_000, 60_000, 120_000]);

/**
 * 目录仍不完整的包在维护节拍上的重试间隔（见 ai/stickers/catalog.ts 的
 * retryIncompleteStickerCatalogs）。
 *
 * 只在启动时对账一次是不够的：`getStickerSet` 失败会让 generatePackCatalog 整包
 * 放弃，而进程按 systemd 托管可以连跑几周——首次部署撞上一次网络抖动，两个贴纸
 * 工具就会对所有回复返回 null 直到下次重启。间隔取分钟级而不是跟着 30 秒的
 * 维护节拍走：包名配错这类永远好不了的情形下，重试本身也要跟着记一条错误日志。
 */
export const STICKER_CATALOG_RETRY_INTERVAL_MS: number = 5 * 60_000;

/** 整包简介与工具意图的领域约束。 */
export const STICKER_PACK_SUMMARY_MAX_CHARS: number = 200;
/** 整包简介生成请求允许的最大输出 token。 */
export const STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4096;
/** 整包简介尚未生成时提供给模型的固定占位。 */
export const STICKER_PACK_SUMMARY_PENDING: string = "（整包简介还在生成中，可进包内查看具体贴纸）";
/** 模型选择贴纸意图文本的最大字符数。 */
export const STICKER_INTENT_MAX_CHARS: number = 80;
