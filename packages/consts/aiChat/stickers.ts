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

/** send_sticker 在串行链发送步骤里展示「正在选择贴纸」的基础停顿和随机抖动（见 aiChat/ai/tools/stickers.ts）。 */
export const STICKER_CHOOSE_DELAY_BASE_MS: number = 1_500;
/** 贴纸选择停顿额外增加的随机时间上界。 */
export const STICKER_CHOOSE_DELAY_JITTER_MS: number = 3_500;

/** 贴纸下载/排队失败或成功响应正文不可用时的业务重采样退避序列。 */
export const STICKER_CATALOG_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 120_000];

/**
 * 单枚贴纸描述在退避序列也用完之后的负缓存时长（见 cache/workers/aiChat/stickers/catalog.ts 的
 * failedEntries）：期间对账跳过该贴纸，到期后由下一次对账重描。远长于
 * STICKER_CATALOG_RETRY_INTERVAL_MS，条目不会永久闩死。
 */
export const STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS: number = 30 * 60_000;

/**
 * 目录仍不完整的包在维护节拍上的重试间隔（见 aiChat/ai/stickers/catalog.ts 的
 * retryIncompleteStickerCatalogs）：目录为空、简介缺失或单枚失败负缓存到期的包，
 * 两次维护重试至少相隔这么久。
 */
export const STICKER_CATALOG_RETRY_INTERVAL_MS: number = 5 * 60_000;

/** 整包简介的最大字符数；超出按子句边界截断（见 aiChat/ai/stickers/catalog.ts 的 summarizePack）。 */
export const STICKER_PACK_SUMMARY_MAX_CHARS: number = 200;

/** 贴纸整包简介请求在错误日志里的调用名；供应商中立，各家实现包共用。 */
export const STICKER_PACK_SUMMARY_ERROR_LABEL: string = "AI sticker pack summary API";
/** 整包简介尚未生成时提供给模型的固定占位。 */
export const STICKER_PACK_SUMMARY_PENDING: string = "（整包简介还在生成中，可进包内查看具体贴纸）";
/** 模型选择贴纸意图文本的最大字符数。 */
export const STICKER_INTENT_MAX_CHARS: number = 80;

/** 贴纸工具没有候选包时共享的只读空菜单。 */
export const EMPTY_STICKER_MENU: readonly [] = [];
