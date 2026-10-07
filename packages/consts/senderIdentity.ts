/** 发送者身份缓存（packages/users/senderIdentity.ts）的调参常量。 */

/** username -> 身份缓存的条目上限，超出按插入顺序淘汰最旧条目；重复发言不刷新位置。 */
export const USER_CACHE_MAX: number = 15_000;
