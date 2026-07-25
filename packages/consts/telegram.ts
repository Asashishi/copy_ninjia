/** Telegram API 封装（packages/infra/telegram/）的调参常量。 */

/** 长轮询订阅的完整 update 类型集合。 */
export const TELEGRAM_ALLOWED_UPDATES: readonly (
  | "message"
  | "channel_post"
  | "message_reaction"
  | "chat_member"
  | "my_chat_member"
  | "callback_query"
  | "inline_query"
  | "chosen_inline_result"
)[] = [
  "message",
  "channel_post",
  "message_reaction",
  "chat_member",
  "my_chat_member",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
] as const;

/** 抓取目标头像（Bot API / t.me 兜底）的单次请求超时。 */
export const AVATAR_FETCH_TIMEOUT_MS: number = 15_000;
/** 抓取目标头像允许的最大尝试次数。 */
export const AVATAR_FETCH_MAX_ATTEMPTS: number = 3;
/** 头像和公开主页分别采用独立硬上限，防止第三方响应导致无界内存占用。 */
export const AVATAR_MAX_DOWNLOAD_BYTES: number = 10 * 1024 * 1024;
/** t.me 公开主页响应允许读入内存的最大字节数。 */
export const PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES: number = 1024 * 1024;
/** getUserProfilePhotos 单页最多能返回的张数，Bot API 本身的硬上限。 */
export const USER_PROFILE_PHOTOS_LIMIT: number = 100;

/** 踢人公告在被自动清理前保持可见的时长。 */
export const KICK_NOTICE_AUTO_DELETE_MS: number = 30 * 1000;

/** Telegram 文本消息的硬性长度上限（字符），超出会被 Bot API 拒绝。 */
export const TELEGRAM_MESSAGE_MAX_CHARS: number = 4096;

/** 遇到 429 时的自动重试参数（配合 apiThrottler 排队使用），bot.api 与
 *  joinVerificationApi 两个客户端共用同一套。 */
export const API_RETRY_MAX_ATTEMPTS: number = 3;
/** Telegram 429 自动重试接受的 retry_after 秒数上限。 */
export const API_RETRY_MAX_DELAY_SECONDS: number = 5;

/** 标题回填的最大并发 getChat 数，限制低优先级维护在共享 throttler 中造成的队头阻塞。 */
export const CHAT_TITLE_REFRESH_CONCURRENCY: number = 15;

/**
 * 自发消息登记表（见 infra/selfSentTracker.ts）的存活时长：只需覆盖「发送 →
 * 更新原样弹回」的往返时间（频道帖自回环、转发进关联讨论组的副本），
 * 未被命中的登记项到期自动清理，不值得长期占内存。
 */
export const SELF_SENT_MESSAGE_TTL_MS: number = 15_000;
