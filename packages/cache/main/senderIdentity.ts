import type { CachedUser } from "../../types/chatState";

/** 发送者身份缓存（packages/users/senderIdentity.ts）的内存状态；进程重启后从空表
 * 开始，由后续发送者消息重新填充。 */

/** 小写 username -> 最近一次观察到的身份，供 /copy、/block 等命令按
 *  @username 解析目标；条数上限见 consts/senderIdentity.ts 的 USER_CACHE_MAX。
 * 任何写入都必须同时维护下方两份按 id 的索引，见 users/senderIdentity.ts。 */
export const userCache: Map<string, CachedUser> = new Map();

/** sender id -> 当前小写 username。用于在发送者改名、去名、username 换绑或
 * 正向缓存淘汰时同步撤销旧 alias，也作为破坏性命令解析前的一致性校验。 */
export const senderUsernameCache: Map<number, string> = new Map();

/**
 * sender id -> 该 id 当前的身份对象，即 `userCache.get(senderUsernameCache.get(id))`
 * 的直查形式。
 *
 * **键集与 senderUsernameCache 恒等**：两张表只在 users/senderIdentity.ts 的
 * updateCachedIdentity 与 deleteAlias 里成对写入、成对删除，容量因此同为
 * consts/senderIdentity.ts 的 USER_CACHE_MAX，淘汰也由那一处的 deleteAlias 一并完成。
 * 值与 userCache 里是同一个 CachedUser 引用，不额外持有对象。
 *
 * 存在的理由只有一个：cacheSender 的稳态判定跑在每条群消息上，要的就是这个对象。
 * 没有本表时那条路径先取 alias 再用字符串键回查 userCache，两次查找里第二次是字符串
 * 键；直查之后只剩一次数值键查找（见 users/senderIdentity.ts 的 cacheSender）。
 *
 * 进程重启后从空表开始，由后续发送者消息与启动预热重新填充，与另外两张表同步；
 * 缺条目表示「这个 id 当前没有缓存身份」，不得解释为沿用旧值。
 */
export const identityById: Map<number, CachedUser> = new Map();
