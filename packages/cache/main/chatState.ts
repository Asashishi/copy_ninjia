import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { LruCache } from "../../libs/lruCache";
import type { ChatState } from "../../types/chatState";
import type { UnacknowledgedChatStateWrite } from "../../types/identityStorage";

/** 主线程群状态 LRU 与未 ACK revision；跨线程只通过 Disk I/O 消息同步。 */

/**
 * SQLite `chat_states` 的唯一主线程热读副本；容量严格为 25。
 *
 * **这里用不到 LruCache 的淘汰**：新建群状态前一律先过
 * `infra/chatStateStorage.ts` 的 `assertChatStateCapacity`，第 26 个群直接抛错，
 * 因此链表永远不会因超容量摘节点。每条消息的读取也都走 `peek` 不刷新热度，
 * 只有 `infra/storage/stateStore.ts` 的 `clearChatStateField` 与
 * `purgeChatStateExceptLockdown` 两处用 `get`。侵入式链表在这份缓存上实际承担的是
 * **有序迭代**：`getActiveProxySendTarget`、`refreshAllChatTitles` 与
 * `antiRaid/lockdownMirror.ts` 的 `recoverAbandonedLockdowns` 都按它遍历，
 * 迭代期改写的语义见 `libs/lruCache.ts` 的 `LruCache`。
 *
 * 生命周期：启动恢复由 `infra/chatStateStorage.ts` 的 `hydrateChatStateCache`
 * 一次填满；条目在清掉最后一个字段后变空、机器人离群且无 lockdown 记录、以及
 * 落盘编码发现该群已空这三处删除；`resetChatStateCache` 在新生命周期启动前整表
 * 清空。进程重启后为空，由启动恢复重建。
 */
export const chatStateCache: LruCache<number, ChatState> =
  new LruCache(STATE_MANAGED_CHAT_LIMIT);

/** 群状态未 ACK revision 与删除墓碑；正文只保留在上方 LRU。 */
export const unacknowledgedChatStateWrites: Map<
  number,
  UnacknowledgedChatStateWrite
> = new Map();

/** 群状态写入 revision 发号器；只在主线程同步自增。 */
export const chatStateWriteRevision: { current: number } = { current: 0 };

/** 应用新生命周期启动前重置 LRU 与一致性水位。 */
export function resetChatStateCache(): void {
  chatStateCache.clear();
  unacknowledgedChatStateWrites.clear();
  chatStateWriteRevision.current = 0;
}
