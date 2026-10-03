/** 主线程 infra/botMessageGate.ts 最多同时记录 512 个发言机器人；容量满时拒绝新身份。 */
export const BOT_MESSAGE_ACTIVITY_MAX_ENTRIES: number = 512;

/** infra/botMessageGate.ts 中同一机器人距最后一条发言满 90 分钟后清除计数。 */
export const BOT_MESSAGE_ACTIVITY_TTL_MS: number = 90 * 60_000;

/** infra/botMessageGate.ts 中同一机器人在连续活跃窗口内最多放行 15 条消息。 */
export const BOT_MESSAGE_ACTIVITY_LIMIT: number = 15;
