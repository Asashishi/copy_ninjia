import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../packages/cache/main/telegram";
import type { TelegramRetryCategory, TelegramRetryLane } from "../../packages/types/telegramOutbound";

function resetLane(lane: TelegramRetryLane): void {
  lane.head = null;
  lane.tail = null;
  lane.activeCount = 0;
  lane.pendingCount = 0;
  lane.retryAt = 0;
  if (lane.retryTimer !== null) clearTimeout(lane.retryTimer);
  lane.retryTimer = null;
  lane.recoveryLimit = 1;
  lane.recoveryActive = 0;
  lane.recovering = false;
}

/** 把主线程 Telegram 出站闸恢复到初始态：新的取消源、接受新工作、各类别退避 lane 与排空等待者清空。 */
export function resetTelegramOutboundGateState(): void {
  telegramOutboundAbortController.current = new AbortController();
  telegramOutboundAccepting.current = true;
  telegramOutboundGateState.activeCount = 0;
  telegramOutboundGateState.retryPendingCount = 0;
  telegramOutboundGateState.aborting = false;
  telegramOutboundGateState.activeJobs.clear();
  for (const category of Object.keys(telegramOutboundGateState.lanes) as TelegramRetryCategory[]) {
    resetLane(telegramOutboundGateState.lanes[category]);
  }
  for (const waiter of telegramOutboundGateState.drainWaiters) clearTimeout(waiter.timer);
  telegramOutboundGateState.drainWaiters.clear();
}
