/**
 * 主线程出站闸（./outboundGate.ts）与发送调度器（./sendScheduler.ts）共用的结算原语：取消与超时原因、
 * 摘除 abort 监听、排空等待者结算与未外交响应体的释放。只读写 cache/main/telegram.ts 的
 * 计数与等待者，不持有状态。
 */

import { telegramOutboundGateState } from "../../cache/main/telegram";
import { isTimeoutAbort } from "../../libs/abortSignal";
import { discardResponseBody } from "../../libs/boundedResponse";
import type { TelegramOutboundJob } from "../../types/telegramOutbound";

/** 出站请求被调用方或生命周期取消时交给调用方的错误。 */
export function abortReason(): Error {
  return new DOMException("Telegram outbound request was aborted.", "AbortError");
}

/**
 * 任务因自身信号中止而结算时交给调用方的错误：信号的中止原因是调用方超时预算耗尽
 * （`isTimeoutAbort`）时给 TimeoutError，生命周期撤销与调用方主动取消给 abortReason。
 * 不持有该信号的消费方（跨线程能力、合并等待）据此区分超时与取消。
 */
export function jobAbortReason(signal: AbortSignal): Error {
  return isTimeoutAbort(signal)
    ? new DOMException("Telegram outbound request timed out.", "TimeoutError")
    : abortReason();
}

/** 摘除任务的一次性 abort 监听；任务结算时调用。 */
export function detachAbortListener(job: TelegramOutboundJob): void {
  if (job.abortListener === undefined) return;
  job.signal.removeEventListener("abort", job.abortListener);
  job.abortListener = undefined;
}

/** 全部已接纳请求都已结算、429 队列为空时结算排空等待者；全局取消进行中不结算。 */
export function settleDrainWaitersIfIdle(): void {
  if (telegramOutboundGateState.aborting) return;
  if (
    telegramOutboundGateState.activeCount !== 0 ||
    telegramOutboundGateState.retryPendingCount !== 0
  ) return;
  settleAllDrainWaiters(true);
}

/** 以 drained 结算并清空全部排空等待者，各自的超时 timer 一并取消。 */
export function settleAllDrainWaiters(drained: boolean): void {
  for (const waiter of telegramOutboundGateState.drainWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(drained);
  }
  telegramOutboundGateState.drainWaiters.clear();
}

/**
 * 释放不再交给调用方的响应体。
 *
 * `telegramRetryAfterMilliseconds` 只读 header、不消费 body，判成 429 后不外交的响应
 * 由这里显式释放（同 telegram/fileDownload.ts 对非 2xx 响应的处理）。
 * 只有 fetch 路径（媒体下载、头像抓取）拿到真正的 Response；grammY transformer 路径返回
 * 已解析的 Bot API 对象，此时为 no-op。
 */
export function releaseResponseBody(response: unknown): void {
  if (response instanceof Response) {
    void discardResponseBody(response);
  }
}
