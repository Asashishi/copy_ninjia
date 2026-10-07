import {
  createRetryLane,
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../packages/cache/main/telegram";
import type { TelegramRetryCategory, TelegramRetryLane } from "../../packages/types/telegramOutbound";
import { resetSendScheduler } from "../../packages/infra/telegram/sendScheduler";

/** 原地复位成 createRetryLane 的初始字段（对象身份不变），先清掉在途的退避定时器。 */
function resetLane(lane: TelegramRetryLane): void {
  if (lane.retryTimer !== null) clearTimeout(lane.retryTimer);
  Object.assign(lane, createRetryLane());
}

/**
 * 把主线程 Telegram 出站闸恢复到初始态：新的取消源、接受新工作、各类别退避 lane、发送调度器的
 * 车道与额度窗口、排空等待者清空。
 */
export function resetTelegramOutboundGateState(): void {
  resetSendScheduler();
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
