/** 主线程 infra/botMessageGate.ts 同时记录的发言机器人上限；容量满时拒绝新身份。 */
export const BOT_MESSAGE_ACTIVITY_MAX_ENTRIES: number = 512;

/** infra/botMessageGate.ts 中同一机器人距最后一条发言满该时长后清除计数。 */
export const BOT_MESSAGE_ACTIVITY_TTL_MS: number = 90 * 60_000;

/** infra/botMessageGate.ts 中同一机器人在连续活跃窗口内最多放行的消息条数。 */
export const BOT_MESSAGE_ACTIVITY_LIMIT: number = 15;
