/** 单条确认 runner 的 Telegram 长轮询时长，单位为秒。 */
export const UPDATE_POLL_TIMEOUT_SECONDS: number = 30;
/** 单条确认 runner 的取数上限；确认边界要求每批恰好至多一条。 */
export const UPDATE_POLL_LIMIT: number = 1;
/** 单次取数的累计重试窗口，跨请求失败与 Telegram 429 等待计时。 */
export const UPDATE_POLL_RETRY_WINDOW_MS: number = 54_000_000;
/** 单次取数第一次失败后的退避时长，后续每次失败翻倍。 */
export const UPDATE_POLL_INITIAL_RETRY_MS: number = 100;
