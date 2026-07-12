/** 入群验证与反刷群私密模式（src/workers/antiRaidWorker.ts）的调参常量。 */

// —— 入群验证 ——

/** 验证按钮上显示的文案，新成员必须在 VERIFICATION_TIMEOUT_MS 内点击，否则会被踢出。 */
export const VERIFICATION_BUTTON_TEXT: string = "我是新人，别搞！";
/** 验证按钮 callback_data 的前缀，后面拼上待验证成员的 userId。 */
export const VERIFY_CALLBACK_PREFIX: string = "verify:";
export const VERIFICATION_TIMEOUT_MS: number = 90 * 1000;
/**
 * 私密模式下直接踢人的占位记录存活时长：只是给 chat_member 更新和
 * new_chat_members 服务消息（针对同一次入群各自触发）留出去重窗口，
 * 不是真的验证超时，所以远比 VERIFICATION_TIMEOUT_MS 短。
 */
export const LOCKDOWN_KICK_DEDUPE_MS: number = 30 * 1000;
/** 验证通过后的欢迎消息在被自动清理前保持可见的时长。 */
export const WELCOME_AUTO_DELETE_MS: number = 30 * 1000;

// —— 反刷群私密模式 ——

/** 滑动计数窗口时长：最近这么长时间内的入群数超过阈值，视为疑似拉人头刷群。 */
export const JOIN_WINDOW_MS: number = 60 * 1000;
/**
 * 滑动窗口内触发私密模式的入群人数阈值。60 秒 30 人（0.5 人/秒）：正常群
 * 极少一分钟涌入 30 个新人，而真实刷群通常远快于此——旧值 150 人/15 秒
 * 要求持续 10 人/秒，实际刷群到不了，形同虚设。
 */
export const JOIN_THRESHOLD: number = 30;
/** 私密模式（禁止普通成员拉人）持续时长。 */
export const LOCKDOWN_MS: number = 5 * 60 * 1000;
/** 解除私密模式的 API 调用失败后，重试前的等待时长。 */
export const RESTORE_RETRY_MS: number = 30 * 1000;
