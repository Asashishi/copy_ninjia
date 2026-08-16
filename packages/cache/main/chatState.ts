import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { LruCache } from "../../libs/lruCache";
import type { ChatState } from "../../types/chatState";
import type { UnacknowledgedChatStateWrite } from "../../types/identityStorage";

/** 主线程群状态 LRU 与未 ACK revision；跨线程只通过 Disk I/O 消息同步。 */

/** SQLite `chat_states` 的唯一主线程热读副本；容量严格为 25。 */
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
