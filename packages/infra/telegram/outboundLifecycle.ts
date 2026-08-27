import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../cache/main/telegram";
import { TELEGRAM_429_RETRY_QUEUE_MAX } from "../../consts/telegram";
import type { FlushResult } from "../../types/lifecycle";
import type {
  TelegramOutboundDrainWaiter,
  TelegramOutboundJob,
  TelegramRetryLane,
} from "../../types/telegramOutbound";
import {
  abortJob,
  abortReason,
  resetRecoveryIfIdle,
} from "./outboundGate";
import { laneFor } from "./outboundQueue";

/** 为新一轮应用生命周期重新武装 Telegram 出站 owner。 */
export function initTelegramOutbound(): void {
  let hasRetryTimer: boolean = false;
  for (const lane of Object.values(telegramOutboundGateState.lanes)) {
    if (lane.retryTimer !== null) hasRetryTimer = true;
  }
  if (
    telegramOutboundGateState.activeCount !== 0 ||
    telegramOutboundGateState.retryPendingCount !== 0 ||
    telegramOutboundGateState.activeJobs.size !== 0 ||
    telegramOutboundGateState.drainWaiters.size !== 0 ||
    hasRetryTimer
  ) {
    throw new Error(
      "Cannot initialize Telegram outbound while the previous lifecycle is unsettled."
    );
  }
  telegramOutboundAbortController.current = new AbortController();
  telegramOutboundGateState.aborting = false;
  telegramOutboundAccepting.current = true;
}

/** 停止接纳新出站任务；已接纳任务仍可在 drain 预算内完成或重试。 */
export function quiesceTelegramOutbound(): void {
  telegramOutboundAccepting.current = false;
}

function clearIdleRetryCooldowns(): void {
  for (const lane of Object.values(telegramOutboundGateState.lanes)) {
    if (lane.head !== null || lane.activeCount !== 0) continue;
    resetRecoveryIfIdle(lane);
  }
}

function settleAllDrainWaiters(drained: boolean): void {
  for (const waiter of telegramOutboundGateState.drainWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(drained);
  }
  telegramOutboundGateState.drainWaiters.clear();
}

/** 预算耗尽后的全局取消：网络、429 timer、队列和调用方 promise 一并结算。 */
function abortTelegramOutbound(): void {
  quiesceTelegramOutbound();
  if (telegramOutboundGateState.aborting) return;
  telegramOutboundGateState.aborting = true;
  telegramOutboundAbortController.current.abort(abortReason());
  for (const lane of Object.values(telegramOutboundGateState.lanes)) {
    if (lane.retryTimer !== null) clearTimeout(lane.retryTimer);
    lane.retryTimer = null;
    lane.retryAt = 0;
    let queued: TelegramOutboundJob | null = lane.head;
    while (queued !== null) {
      const next: TelegramOutboundJob | null = queued.next;
      abortJob(queued);
      queued = next;
    }
    lane.recovering = false;
    lane.recoveryLimit = 1;
  }
  for (const active of [...telegramOutboundGateState.activeJobs]) {
    abortJob(active);
  }
  telegramOutboundGateState.aborting = false;
  settleAllDrainWaiters(false);
}

/** 当前 Telegram 出站闸门的轻量状态快照。 */
export function telegramOutboundStats(): Readonly<{
  active: number;
  pending: number;
  capacity: number;
  messageActive: number;
  messageRetryPending: number;
}> {
  const messageLane: TelegramRetryLane = laneFor("message");
  return {
    active: telegramOutboundGateState.activeCount,
    pending: telegramOutboundGateState.retryPendingCount,
    capacity: TELEGRAM_429_RETRY_QUEUE_MAX,
    messageActive: messageLane.activeCount,
    messageRetryPending: messageLane.pendingCount,
  };
}

interface DrainTelegramOutboundOptions {
  /** false 只排空当前任务而不关闭入口；预算耗尽仍会全局 abort。 */
  readonly quiesce?: boolean;
}

/** 在生命周期预算内等待所有已接纳的 Telegram 出站请求结算。 */
export function drainTelegramOutbound(
  timeoutMs: number,
  { quiesce = true }: DrainTelegramOutboundOptions = {}
): Promise<FlushResult> {
  if (quiesce) quiesceTelegramOutbound();
  clearIdleRetryCooldowns();
  if (
    telegramOutboundGateState.activeCount === 0 &&
    telegramOutboundGateState.retryPendingCount === 0
  ) return Promise.resolve("flushed");
  if (timeoutMs <= 0) {
    abortTelegramOutbound();
    return Promise.resolve("timedOut");
  }
  return new Promise<FlushResult>((
    resolve: (result: FlushResult) => void
  ): void => {
    const waiter: TelegramOutboundDrainWaiter = {
      resolve: (drained: boolean): void =>
        resolve(drained ? "flushed" : "timedOut"),
      timer: setTimeout((): void => {
        if (!telegramOutboundGateState.drainWaiters.delete(waiter)) return;
        abortTelegramOutbound();
        resolve("timedOut");
      }, timeoutMs),
    };
    telegramOutboundGateState.drainWaiters.add(waiter);
  });
}
