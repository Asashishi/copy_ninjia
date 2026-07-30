import type { PendingNoticeDeletion } from "../../../types/antiRaid/internal";

/** 群内公告延迟自撤（packages/workers/antiRaid/noticeCleanup.ts）的 Worker 侧内存状态。 */

/**
 * 已经发出、还等着到点自删的群内公告。
 *
 * 由 scheduleNoticeDeletion 逐条填充，定时器自己触发后就地摘除；停机 drain 前
 * 由 flushPendingNoticeDeletions 一次性清空——把还没到点的那些**立刻**删掉，
 * 而不是留在群里。这张表存在的唯一理由就是这次 flush：`setTimeout(...).unref()`
 * 活在 Worker 的 isolate 里，崩溃重建、`stopAntiRaidWorker`、`systemctl restart`
 * 都会把它连同定时器一起丢掉，公告则永久留在群里点着某个成员的名——刷屏禁言
 * 的公告要挂满 FLOOD_MUTE_DURATION_MS（5 分钟），敞口是踢人战报（30 秒）的十倍。
 *
 * 纯内存、不落盘：进程重启后这批公告的删除责任就此丢失，属于已知取舍——
 * flush 覆盖的是有序停机，硬崩溃仍会漏。条目数天然被「同时在禁言中的人数」
 * 封顶，不需要额外的容量上限。
 */
export const pendingNoticeDeletions: Set<PendingNoticeDeletion> = new Set();
