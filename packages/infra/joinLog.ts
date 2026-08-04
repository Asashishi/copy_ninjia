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

/**
 * 记录一条权威 `chat_member` 入群事实；只在这条事实已经 durable、或已被落盘
 * Worker 的恢复缓冲接管后返回 true。
 *
 * 「已缓冲待写」必须与「写入失败」分开报。Worker 因单次文件错误崩溃后，
 * onerror 会拉起替身并进入恢复握手期，那段窗口里 `postDiskIO` 把消息压进有
 * 硬顶的 FIFO 并返回 true，而 `flushDiskIODomain` 因为没有可写的 Worker 直接
 * 短路成 `"failed"`——同一个函数里两套语义。照 `"failed"` 报的话，窗口内任意
 * 用户入群都会让 antiRaid/updateIngress.ts 抛错、经 bot.catch rethrow 让
 * handleUpdate reject，进而使 ApplicationLifecycle.run() 以退出码 1 结束并**扣住
 * 最终 offset**，Telegram 把上次确认点之后的全部更新重投一遍——一次可自愈的
 * 瞬时故障被放大成整进程退出加重复投递。
 *
 * 缓冲不是静默丢弃：握手结束后 activateDiskIOWorker 原序重放这条消息，重放
 * 失败或缓冲触顶都会走 stopWorkerAfterLoadFailure 的统一 fatal 停机路径。
 */
export async function recordJoinLog({
  chatId,
  userId,
  joinedAt,
}: RecordJoinLogParams): Promise<boolean> {
  // 必须在投递**之前**取样：投递之后 Worker 可能刚好完成握手转为可写，那时
  // 再问就会把「这条已经进了缓冲」误读成「这条已经发出去了」。
  const bufferedDuringRecovery: boolean = diskIO.isDiskIOBuffering();
  if (!diskIO.postDiskIO({
    type: "joinLog",
    chatId,
    userId,
    joinedAt,
    day: getTokyoDateKey(new Date(joinedAt)),
  })) {
    return false;
  }
  if (bufferedDuringRecovery) return true;
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
