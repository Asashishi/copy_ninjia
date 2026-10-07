/** owner: main。群类型观测（packages/antiRaid/chatKind.ts）的主线程内存状态。 */

/**
 * 各群是不是超级群，纯内存、不落盘。
 *
 * 权威线程是主线程（update 携带 `chat.type`），入群守卫线程的镜像见
 * `cache/workers/antiRaid/chatKind.ts`。本表兼作投递去重：observeChatKind 只在值变化时
 * 向 Worker 增量投递 `chatKind` 消息；Worker 重建时由 antiRaid/workerBridge/replay.ts 整表重放。
 * 「无条目」表示尚未观测到类型，Worker 侧按「此刻不知道」处理。
 *
 * 只记录已 /init enable 的群，容量上限 STATE_MANAGED_CHAT_LIMIT（见 consts/storage.ts）。
 * `deactivateChat` / 群 teardown 时由 antiRaid/workerBridge/observers.ts 删除，进程重启后为空，
 * 由已接管群的随后一次 update 或首次启用命令重新填上。
 */
export const chatIsSupergroupById: Map<number, boolean> = new Map();
