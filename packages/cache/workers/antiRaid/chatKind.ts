/** owner: workers/antiRaid。群类型的 Worker 侧镜像（packages/workers/antiRaid/chatKind.ts）。 */

/**
 * 各群是不是超级群，由主线程按变更镜像过来。
 *
 * 权威副本在主线程（`packages/cache/main/antiRaid/chatKind.ts`），本表是执行侧的只读快照，
 * 主线程按群增量推送 `chatKind` 消息。踢人在本线程发请求，「只踢不封」在两类群里是两个不同的
 * Bot API 方法：`unbanChatMember` 按官方文档只认超级群/频道，普通群用 `banChatMember`。
 *
 * 「没有条目」表示此刻未知，不表示「是普通群」。口径同 workerBotChatPermissions：
 * 未知不授权任何踢人 API，执行侧先用 getChat 补齐；只有确证是普通群（值为 false）才改道，
 * undefined 与 false 不压成同一个布尔。
 *
 * 重放方：Worker 重建时由主线程整表重放并填充；完整进程冷启动镜像为空时由执行侧反查。
 * `deactivateChat` 与 Worker stop 时清除，不按容量淘汰。
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
