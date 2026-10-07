/** owner: workers/antiRaid。Anti-Raid Worker 异步副作用排空（packages/workers/antiRaid/taskTracker.ts）的内存状态，以及
 * 停机取消信号的取用入口 antiRaidDispatchSignal。
 */

/**
 * 已启动且尚未结算的网络副作用。任务完成时由 tracker 删除；Worker stop 时
 * 整体清空，重建后由主线程持久化镜像重新投递必要任务。
 *
 * 容量：不设硬顶；集合包含已受理请求与查询续体，数量由各路入口
 * 自己的闸（验证查询/回执硬顶、按群串行链、判定在途上限）封住。
 */
export const antiRaidInFlightTasks: Set<Promise<unknown>> = new Set();

/**
 * tracker 生命周期代际。Worker stop 时递增，使旧 Promise 的迟到结算
 * 不能清理下一次 start 已建立的新任务状态。
 */
export const antiRaidTaskTrackerGeneration: { current: number } = { current: 0 };

/**
 * 「本 Worker 正在停机」的取消信号源，供排队时长可能超过 drain 预算的尽力而为请求订阅：
 * 这类请求可能等待 grammY 消息桶或各自类别的 Telegram 429 retry_after，刷屏禁言的发送超时为
 * FLOOD_MUTE_DISPATCH_TIMEOUT_MS（见 consts/antiRaid/flood.ts）。drain 到达时就地 abort，
 * 排队中的请求立刻结算成失败。
 *
 * 生命周期：懒创建（第一个要发这类请求的调用方经 antiRaidDispatchSignal 创建）；drain 分支调
 * quiesceAntiRaidDispatch 就地 abort，此后一直是已 abort 状态，停机之后到达的请求不再排队。
 * Worker 崩溃重建随 isolate 重来，无需 adopt；Worker stop 与测试隔离由 resetAntiRaidTaskTracker 置回 null。
 *
 * 不覆盖 drain 自己要发的请求：停机 flush 的公告删除（统一 deleteMessageAfter flush）不订阅这个信号。
 */
export const antiRaidDispatchAbort: { current: AbortController | null } = { current: null };

/**
 * 排队时长可能超过 drain 预算的尽力而为请求共用的取消信号；控制器不存在时懒创建。
 * 停机之后取到的是已 abort 的信号，请求立刻结算成失败，契约见上方 antiRaidDispatchAbort。
 */
export function antiRaidDispatchSignal(): AbortSignal {
  antiRaidDispatchAbort.current ??= new AbortController();
  return antiRaidDispatchAbort.current.signal;
}
