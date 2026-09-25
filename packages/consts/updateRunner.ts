/** 单条确认 runner 的 Telegram 长轮询时长，单位为秒。 */
export const UPDATE_POLL_TIMEOUT_SECONDS: number = 30;
/** 单条确认 runner 的取数上限；确认边界要求每批恰好至多一条。 */
export const UPDATE_POLL_LIMIT: number = 1;
/** 单次取数的累计重试窗口（15 小时），跨请求失败与 Telegram 429 等待计时。 */
export const UPDATE_POLL_RETRY_WINDOW_MS: number = 15 * 60 * 60_000;
/** 单次取数第一次失败后的退避时长，后续每次失败翻倍，直到 UPDATE_POLL_MAX_RETRY_MS。 */
export const UPDATE_POLL_INITIAL_RETRY_MS: number = 100;
/**
 * 单次失败退避的封顶时长。断网期间退避停在这一档，网络恢复后最多再等这么久
 * 就重新取数；窗口耗尽前按这个间隔持续重试。所属模块：app/updateFetcher.ts。
 */
export const UPDATE_POLL_MAX_RETRY_MS: number = 30_000;
