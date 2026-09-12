/**
 * 滚动 24 小时入群日志的主线程入口。写入只投递最小事件给 Disk I/O Worker，
 * 主线程不保留成员列表；读取仅由 `/batch_kick` 发起，整群删除由群 teardown 的
 * `joinLog` owner 发起（本模块在加载时反向注册那个 owner）。
 */

import { getTokyoDateKey } from "../libs/time";
import { purgesChatData } from "../libs/chatTeardown";
import type { ChatTeardownReason } from "../types/chatTeardown";
import type { JoinLogRecord } from "../types/diskIO/storage";
import { registerChatTeardown } from "./chatTeardownRegistry";
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
 * handleUpdate reject，进而使 ApplicationLifecycle.run("main") 以退出码 1 结束并**扣住
 * 最终 offset**，Telegram 把上次确认点之后的全部更新重投一遍——一次可自愈的
 * 瞬时故障被放大成整进程退出加重复投递。
 *
 * 缓冲不是静默丢弃：握手结束后 activateDiskIOWorker 原序重放这条消息，重放
 * 失败或缓冲触顶都会走 stopWorkerAfterLoadFailure 的统一 fatal 停机路径。
 *
 * 这条承诺靠的是重放区间标记（见 types/diskIO.ts 的 RecoveryReplayRequest）：
 * 缓冲这一刻本函数就已经放行了该 update，此后没有任何 flush 会再问它写没写进去，
 * 因此 Worker 必须知道自己正在重放，才能把区间内的写失败从「记个拒收标记等下一次
 * flush 回报」升级成停机。没有这道标记的话，拒收标记会挂到某个**无关**的后续入群
 * 事实那次 flush 上——那一条被连坐重投，真正丢掉的这一条却没有任何痕迹。
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

/**
 * 群 teardown 的整群删除：删掉本群保留窗口内的全部入群日志文件。
 *
 * 只在本次 teardown 要删数据时发出（见 libs/chatTeardown.ts 的 purgesChatData）；
 * 被撤管理员那一路不动日志，权限加回来之后 `/batch_kick` 仍要查得到这 24 小时。
 *
 * 等 durable 回执而不是投完就走：入群日志是 `/batch_kick` 的唯一信源，删除没落盘
 * 就重启，一个已经不再接管的群的成员名单会继续躺在 `memory/joinlog/` 里，直到
 * 保留窗口自然过期。失败原样上抛，由 teardown 的组合边界汇总（见
 * infra/chatTeardown.ts），`/init disable` 据此回执「有几样没拆干净」。
 *
 * 等的是 `joinLogPurge` 而不是追写那一格 `joinLog`：删除失败只该让这一次 teardown
 * 如实回报，绝不能让 recordJoinLog 把所有群的入群 update 一起判成未落盘
 * （见 types/diskIO/replies.ts 的 DiskIODomain）。
 */
export async function purgeChatJoinLog(chatId: number): Promise<void> {
  if (!diskIO.postDiskIO({ type: "deleteJoinLog", chatId })) {
    throw new Error(`Disk I/O refused the join log deletion for chat ${chatId}.`);
  }
  if (await diskIO.flushDiskIODomain("joinLogPurge") !== "flushed") {
    throw new Error(`Failed to delete the join logs for chat ${chatId}.`);
  }
}

registerChatTeardown("joinLog", (
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> | undefined => purgesChatData(reason) ? purgeChatJoinLog(chatId) : undefined);
