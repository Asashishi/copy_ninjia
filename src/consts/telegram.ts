/** Telegram API 封装（src/telegram.ts）的调参常量。 */

// 抓取目标头像（Bot API / t.me 主页兜底）的超时与重试次数。
export const AVATAR_FETCH_TIMEOUT_MS: number = 15000;
export const AVATAR_FETCH_MAX_ATTEMPTS: number = 3;

/** 踢人公告在被自动清理前保持可见的时长。 */
export const KICK_NOTICE_AUTO_DELETE_MS: number = 30 * 1000;
