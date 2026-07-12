/** 入群验证（src/joinVerification.ts）的调参常量。 */

/** 新成员必须在 VERIFICATION_TIMEOUT_MS 内发送的精确文本，否则会被踢出。 */
export const VERIFICATION_CODE: string = "我是新人，别搞！";
export const VERIFICATION_TIMEOUT_MS: number = 90 * 1000;
/**
 * 私密模式下直接踢人的占位记录存活时长：只是给 chat_member 更新和
 * new_chat_members 服务消息（针对同一次入群各自触发）留出去重窗口，
 * 不是真的验证超时，所以远比 VERIFICATION_TIMEOUT_MS 短。
 */
export const LOCKDOWN_KICK_DEDUPE_MS: number = 30 * 1000;
