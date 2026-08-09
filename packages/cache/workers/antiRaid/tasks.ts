/** Anti-Raid Worker 异步副作用排空（packages/workers/antiRaid/taskTracker.ts）的内存状态。 */

/**
 * 已启动且尚未结算的网络副作用。任务完成时由 tracker 删除；Worker stop 时
 * 整体清空，重建后由主线程持久化镜像重新投递必要任务。
 */
export const antiRaidInFlightTasks: Set<Promise<unknown>> = new Set();

/**
 * tracker 生命周期代际。Worker stop 时递增，使旧 Promise 的迟到 finally
 * 不能清理下一次 start 已建立的新任务状态。
 */
export const antiRaidTaskTrackerGeneration: { current: number } = { current: 0 };

/**
 * 「本 Worker 正在停机」的取消信号源，供**排队时长可以远超 drain 预算**的尽力
 * 而为请求订阅。
 *
 * drain 的预算是 ANTI_RAID_BARRIER_TIMEOUT_MS 那一档的秒级数值，而登记进上面那个
 * 在途集合的请求可能等待 grammY 消息桶，也可能等待各自类别的 Telegram 429
 * retry_after；刷屏禁言更是**按设计**最长等待 FLOOD_MUTE_DISPATCH_TIMEOUT_MS（2 分钟，见
 * consts/antiRaid/flood.ts）。停机恰好落在排队期间时，drain 等不到结算就超时，
 * 生命周期据此拒绝确认 Telegram offset 并以非零状态退出——重启后整批 update 被
 * 重投（重复的验证踢人与通知），systemd 报单元失败。drain 到达时就地 abort：
 * 排队中的请求立刻结算成失败，而这些处置本就是尽力而为的，丢一次不构成安全
 * 边界失守（同 adDetect/queue.ts 的 runAdDetectBatch 干脆不登记的理由）。
 *
 * 生命周期：懒创建（第一个要发这类请求的调用方创建）；drain 分支调
 * quiesceAntiRaidDispatch 就地 abort，此后**一直**是已 abort 状态——停机之后
 * 才到达的候选也就不再排队。Worker 崩溃重建随 isolate 重来，无需 adopt；
 * Worker stop 与测试隔离由 resetAntiRaidTaskTracker 换一个新的。
 *
 * **不覆盖 drain 自己要发的那些请求**：停机 flush 的公告删除是 drain 期间**必须
 * 发出去**的（见统一 deleteMessageAfter flush），它们不订阅这个信号；先撤业务
 * 请求再创建这些删除任务，也避免把新任务误归进已经取消的生命周期。
 */
export const antiRaidDispatchAbort: { current: AbortController | null } = { current: null };
