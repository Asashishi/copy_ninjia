import type { CachedUser } from "../types/chatState";

/** 发送者身份缓存（packages/users/senderIdentity.ts）的内存状态。 */

/** 小写 username -> 最近一次观察到的身份，供 /copy、/kick 等命令按
 *  @username 解析目标；条数上限见 consts/senderIdentity.ts 的 USER_CACHE_MAX。
 * 任何写入都必须同时维护下方反向索引，见 users/senderIdentity.ts。 */
export const userCache: Map<string, CachedUser> = new Map();

/** sender id -> 当前小写 username。用于在发送者改名、去名、username 换绑或
 * 正向缓存淘汰时同步撤销旧 alias，也作为破坏性命令解析前的一致性校验。 */
export const senderUsernameCache: Map<number, string> = new Map();
