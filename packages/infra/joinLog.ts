/**
 * 入群日志的主线程写入与删除入口。写入只投递最小事件给 Disk I/O
 * Worker，主线程只保留未确认落盘的事实镜像（cache/main/joinLog.ts），不保留成员列表；
 * 读取由 `/batch_kick` 直接调用 infra/diskIO.ts 的 readJoinLog；整群删除由群 teardown
 * 的 `joinLog` owner 发起（本模块在加载时反向注册那个 owner）。
 */

import { getDateKey } from "../libs/time";
import { purgesChatData } from "../libs/chatTeardown";
import { joinLogSequence, unacknowledgedJoinLogs } from "../cache/main/joinLog";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import { JOIN_LOG_MAX_BUFFERED_ENTRIES } from "../consts/diskIO/joinLog";
import type { ChatTeardownReason } from "../types/chatTeardown";
import type {
  DiskIORecoveryTransport,
  JoinLogDiskMessage,
} from "../types/diskIO/messages";
import type { JoinLogPersistedReply } from "../types/diskIO/replies";
import { registerChatTeardown } from "./chatTeardownRegistry";
import * as diskIO from "./diskIO";

export interface RecordJoinLogParams {
  chatId: number;
  userId: number;
  joinedAt: number;
}

/**
 * 记录一条权威 `chat_member` 入群事实：投递给 Disk I/O Worker 的入群批次并登记进未确认
 * 镜像后立即返回，不等待落盘。Worker 按 FLUSH_MAX_ENTRIES 条或 FLUSH_INTERVAL_MS 批量
 * 追写，并以 joinLogPersisted 回执释放已处置的事实；Worker 崩溃重建时镜像原序重放，停机
 * 统一 flush 写出剩余批次。进程被强杀或断电时，最近一个窗口内尚未落盘的事实会丢失。
 *
 * @returns 已受理为 true；镜像已满 JOIN_LOG_MAX_BUFFERED_ENTRIES（磁盘持续写不进）或
 *   Disk I/O 拒收时为 false，调用方据此让 update 失败，由 Telegram 重投。
 */
export function recordJoinLog({
  chatId,
  userId,
  joinedAt,
}: RecordJoinLogParams): boolean {
  if (unacknowledgedJoinLogs.size >= JOIN_LOG_MAX_BUFFERED_ENTRIES) return false;
  const message: JoinLogDiskMessage = {
    type: "joinLog",
    sequence: joinLogSequence.current + 1,
    chatId,
    userId,
    joinedAt,
    day: getDateKey(joinedAt),
  };
  if (!diskIO.postDiskIO(message)) return false;
  joinLogSequence.current = message.sequence;
  unacknowledgedJoinLogs.push(message);
  return true;
}

/** 处置回执释放镜像：序号不超过 through 且不在 pending 里的事实已写入或丢弃。 */
function settleJoinLogPersisted(reply: JoinLogPersistedReply): void {
  if (reply.pending.length === 0) {
    unacknowledgedJoinLogs.removeWhere(
      (message: JoinLogDiskMessage): boolean => message.sequence <= reply.through
    );
    return;
  }
  const pending: ReadonlySet<number> = new Set(reply.pending);
  unacknowledgedJoinLogs.removeWhere(
    (message: JoinLogDiskMessage): boolean =>
      message.sequence <= reply.through && !pending.has(message.sequence)
  );
}

/** Worker 重建后原序重放全部未确认事实；已写过的精确重投由磁盘索引在追加前跳过。 */
function replayJoinLogs(transport: DiskIORecoveryTransport): boolean {
  for (const message of unacknowledgedJoinLogs.values()) {
    if (!transport.post(message)) return false;
  }
  return true;
}

/** 整群删除接管该群的未确认事实：从镜像摘除，其余条目保持原有顺序。 */
function dropChatJoinLogs(chatId: number): void {
  unacknowledgedJoinLogs.removeWhere(
    (message: JoinLogDiskMessage): boolean => message.chatId === chatId
  );
}

/**
 * 群 teardown 的整群删除：删掉本群保留窗口内的全部入群日志文件。
 *
 * 只在本次 teardown 要删数据时发出（见 libs/chatTeardown.ts 的 purgesChatData）；
 * 被撤管理员的路径不动日志。
 *
 * 等 `joinLogPurge` 领域的 durable 回执后返回；该屏障只刷这一个领域，不牵动追写的
 * `joinLog` 领域（见 types/diskIO/replies.ts 的 DiskIODomain）。失败原样上抛，
 * 由 teardown 的组合边界汇总（见 infra/chatTeardown.ts）。
 */
export async function purgeChatJoinLog(chatId: number): Promise<void> {
  if (!diskIO.postDiskIO({ type: "deleteJoinLog", chatId })) {
    throw new Error(`Disk I/O refused the join log deletion for chat ${chatId}.`);
  }
  // 删除消息排在该群所有已投递事实之后，Worker 丢掉仍在缓冲里的那些；镜像同步摘除。
  dropChatJoinLogs(chatId);
  if ((await diskIO.flushDiskIODomain("joinLogPurge")).result !== "flushed") {
    throw new Error(`Failed to delete the join logs for chat ${chatId}.`);
  }
}

registerChatTeardown("joinLog", (
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> | undefined => purgesChatData(reason) ? purgeChatJoinLog(chatId) : undefined);

diskIO.onDiskIOReply("joinLogPersisted", settleJoinLogPersisted);
diskIO.onDiskIORespawn("join log", DISK_IO_RESPAWN_PRIORITIES.JOIN_LOG, replayJoinLogs);
