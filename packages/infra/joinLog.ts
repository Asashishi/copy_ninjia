/**
 * 滚动 24 小时入群日志的主线程入口。写入只投递最小事件给 Disk I/O Worker，
 * 主线程不保留成员列表；读取仅由 `/batch_kick` 发起。
 */

import { getTokyoDateKey } from "../libs/time";
import type { JoinLogRecord } from "../types/diskIO/storage";
import * as diskIO from "./diskIO";

export interface RecordJoinLogParams {
  chatId: number;
  userId: number;
  joinedAt: number;
}

/** 记录一条权威 `chat_member` 入群事实；只在 joinLog 领域已经 durable 后返回 true。 */
export async function recordJoinLog({
  chatId,
  userId,
  joinedAt,
}: RecordJoinLogParams): Promise<boolean> {
  if (!diskIO.postDiskIO({
    type: "joinLog",
    chatId,
    userId,
    joinedAt,
    day: getTokyoDateKey(new Date(joinedAt)),
  })) {
    return false;
  }
  return await diskIO.flushDiskIODomain("joinLog") === "flushed";
}

export interface ReadRecentJoinLogParams {
  chatId: number;
  since: number;
  now: number;
}

/** 按需读取本群滚动区间内的入群记录，至多覆盖两个东京自然日。 */
export function readRecentJoinLog({
  chatId,
  since,
  now,
}: ReadRecentJoinLogParams): Promise<readonly JoinLogRecord[]> {
  return diskIO.readJoinLog({
    chatId,
    since,
    now,
  });
}
