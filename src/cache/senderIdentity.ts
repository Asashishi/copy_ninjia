import type { CachedUser } from "../types/chatState";

/** 发送者身份缓存（src/users/senderIdentity.ts）的内存状态。 */

/** 小写 username -> 最近一次观察到的身份，供 /copy、/kick 等命令按
 *  @username 解析目标；条数上限见 consts/senderIdentity.ts 的 USER_CACHE_MAX。 */
export const userCache: Map<string, CachedUser> = new Map();
