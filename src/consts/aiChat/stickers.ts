/** getStickerSet 失败后的短期负缓存；到期后同进程可重新请求。 */
export const STICKER_SET_FAILURE_RETRY_MS: number = 60_000;

/** 一轮回复最多发送一枚贴纸。 */
export const MAX_STICKERS_PER_REPLY: number = 1;

/** view_sticker_pack 展示「正在选择贴纸」的基础停顿和随机抖动。 */
export const STICKER_CHOOSE_DELAY_BASE_MS: number = 1_500;
export const STICKER_CHOOSE_DELAY_JITTER_MS: number = 3_500;

/** 贴纸目录单次 AI 调用失败后的跨请求退避序列。 */
export const STICKER_CATALOG_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 120_000];

/** 整包简介与工具意图的领域约束。 */
export const STICKER_PACK_SUMMARY_MAX_CHARS: number = 200;
export const STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4096;
export const STICKER_PACK_SUMMARY_PENDING: string = "（整包简介还在生成中，可进包内查看具体贴纸）";
export const STICKER_INTENT_MAX_CHARS: number = 80;
