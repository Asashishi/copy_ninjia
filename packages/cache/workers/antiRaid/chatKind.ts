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
 * workerBotChatPermissions 完全一致：未知一律按现状走 `unbanChatMember`，只有
 * 确证是普通群（值为 false）才改道。压成一个布尔的代价是把绝大多数超级群在
 * 镜像到达之前误判成普通群，那会在超级群里打出真正的持久封禁。
 *
 * Worker 重建与进程启动时由主线程整表重放，因此这里不需要自己的恢复逻辑；
 * `deactivateChat` 与 Worker stop 时清除。
 */
export const workerChatIsSupergroup: Map<number, boolean> = new Map();
