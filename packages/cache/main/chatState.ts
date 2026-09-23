import type { ChatState } from "../../types/chatState";
import type { UnacknowledgedChatStateWrite } from "../../types/identityStorage";

/** 主线程群状态热读副本与未 ACK revision；跨线程只通过 Disk I/O 消息同步。 */

/**
 * SQLite `chat_states` 的唯一主线程热读副本；容量上界 STATE_MANAGED_CHAT_LIMIT（25）。
 *
 * 容量由写入方保证而不是淘汰：新建群状态前一律先过 `infra/chatStateStorage.ts` 的
 * `assertChatStateCapacity`，第 26 个群直接抛错。读取不改变任何顺序；迭代按插入
 * 顺序（启动恢复顺序，其后按新建顺序），覆盖同键保持原位，迭代中删除条目安全。
 * `getActiveProxySendTarget`、`refreshAllChatTitles` 与 `antiRaid/lockdownMirror.ts`
 * 的 `recoverAbandonedLockdowns` 都按它遍历，均不依赖特定顺序。
 *
 * 生命周期：启动恢复由 `infra/chatStateStorage.ts` 的 `hydrateChatStateCache`
 * 一次填满；条目在清掉最后一个字段后变空、机器人离群且无 lockdown 记录、以及
 * 落盘编码发现该群已空这三处删除；`resetChatStateCache` 在新生命周期启动前整表
 * 清空。进程重启后为空，由启动恢复重建。
 */
export const chatStateCache: Map<number, ChatState> = new Map();

/**
 * 群状态未 ACK revision 与删除墓碑；正文只保留在上方热读副本。
 * 清理：收到该 revision 的精确 ACK 时按 chatId 删除；Disk I/O Worker 重建时
 * 不清空，整表重放后等 ACK 才移出。容量：每个受管群至多一项，上界
 * STATE_MANAGED_CHAT_LIMIT；不淘汰未落盘事实。
 */
export const unacknowledgedChatStateWrites: Map<
  number,
  UnacknowledgedChatStateWrite
> = new Map();

/** 群状态写入 revision 发号器；只在主线程同步自增。 */
export const chatStateWriteRevision: { current: number } = { current: 0 };

/** 应用新生命周期启动前重置热读副本与一致性水位。 */
export function resetChatStateCache(): void {
  chatStateCache.clear();
  unacknowledgedChatStateWrites.clear();
  chatStateWriteRevision.current = 0;
}
