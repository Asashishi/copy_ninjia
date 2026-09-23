/** 群类型的 Worker 侧镜像（packages/workers/antiRaid/chatKind.ts）。 */

/**
 * 各群是不是超级群，由主线程按变更镜像过来。
 *
 * 权威副本在主线程（`packages/cache/main/antiRaid/chatKind.ts`，唯一能看到
 * `chat.type` 的地方），这里只是执行侧的只读快照：踢人在本线程发请求，而
 * 「只踢不封」在两类群里是两个不同的 Bot API 方法——`unbanChatMember` 按官方
 * 文档只认超级群/频道，普通群要用 `banChatMember`（那里它不产生持久封禁）。
 *
 * **「没有条目」表示「此刻不知道」，不表示「是普通群」。** 口径与
 * workerBotChatPermissions 完全一致：未知不会授权任何踢人 API，执行侧先用
 * getChat 补齐；只有确证是普通群（值为 false）才改道。压成一个布尔的代价是
 * 把绝大多数超级群误判成普通群，在那里打出真正的持久封禁。
 *
 * Worker 重建时由主线程整表重放并填充；完整进程冷启动镜像为空时由执行侧反查。
 * `deactivateChat` 与 Worker stop 时清除，没有按容量的淘汰——误删一项等于把
 * 一个超级群重新当成「不知道」，只是多付一次 getChat。
 * 容量：每个受管群一项，上界 STATE_MANAGED_CHAT_LIMIT（见 consts/storage.ts）。
 */
export const workerChatIsSupergroup: Map<number, boolean> = new Map();

/**
 * 冷启动镜像缺失时按群复用的 getChat 请求；请求结算、镜像到达、停管或 Worker
 * stop 时删除。作废的请求仍留在 workerChatKindActiveFetches 计入并发，
 * 本表容量不超过 VERIFICATION_CHAT_KIND_FETCH_MAX，Worker 重建后为空。
 */
export const workerChatKindFetches: Map<
  number,
  Promise<boolean | undefined>
> = new Map();

/**
 * 已发出且尚未结算的 getChat 请求，包含镜像到达或停管后从按群复用表中作废的请求。
 * 请求结算时删除；Worker stop 时清空，重建后从空表开始。容量由
 * VERIFICATION_CHAT_KIND_FETCH_MAX 限制，作废旧请求不会提前归还并发名额。
 */
export const workerChatKindActiveFetches: Set<Promise<boolean | undefined>> = new Set();
