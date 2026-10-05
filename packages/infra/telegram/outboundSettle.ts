/**
 * 主线程出站闸（./outboundGate.ts）与发送调度器（./sendScheduler.ts）共用的结算原语：取消原因、
 * 摘除 abort 监听、排空等待者结算与未外交响应体的释放。只读写 cache/main/telegram.ts 的
 * 计数与等待者，不持有状态。
 */

import { telegramOutboundGateState } from "../../cache/main/telegram";
import { discardResponseBody } from "../../libs/boundedResponse";
import type { TelegramOutboundJob } from "../../types/telegramOutbound";

/** 出站请求被调用方或生命周期取消时交给调用方的错误。 */
export function abortReason(): Error {
  return new DOMException("Telegram outbound request was aborted.", "AbortError");
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
  for (const waiter of telegramOutboundGateState.drainWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
  telegramOutboundGateState.drainWaiters.clear();
}

/**
 * 释放不再交给调用方的响应体。
 *
 * `telegramRetryAfterMilliseconds` 只读 header，不消费 body；被它判成 429 之后
 * 又不往外交的那些响应，如果就这么丢掉，body 会一直占着连接与缓冲——正是
 * telegram/fileDownload.ts 里「非 2xx 响应不读错误页，并显式释放响应体」防的那件事。
 * 只有 fetch 那条路（媒体下载、头像抓取）拿得到真正的 Response；grammY
 * transformer 那条路返回的是已解析的 Bot API 对象，这里恒为 no-op。
 */
export function releaseResponseBody(response: unknown): void {
  if (response instanceof Response) {
    void discardResponseBody(response);
  }
}
