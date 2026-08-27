import { telegramOutboundGateState } from "../../cache/main/telegram";
import { TELEGRAM_429_RETRY_QUEUE_MAX } from "../../consts/telegram";
import type {
  TelegramOutboundJob,
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../types/telegramOutbound";

/** 取一个 429 类别的唯一队列 owner。 */
export function laneFor(category: TelegramRetryCategory): TelegramRetryLane {
  return telegramOutboundGateState.lanes[category];
}

/** 把任务接到侵入式 FIFO 尾部；达到全局硬顶时不修改状态。 */
export function appendRetryJob(job: TelegramOutboundJob): boolean {
  if (
    telegramOutboundGateState.retryPendingCount >=
    TELEGRAM_429_RETRY_QUEUE_MAX
  ) return false;
  const lane: TelegramRetryLane = laneFor(job.category);
  const tail: TelegramOutboundJob | null = lane.tail;
  job.previous = tail;
  job.next = null;
  if (tail === null) lane.head = job;
  else tail.next = job;
  lane.tail = job;
  job.state = "retryQueued";
  job.fromRetryQueue = true;
  telegramOutboundGateState.retryPendingCount++;
  lane.pendingCount++;
  return true;
}

/** 从侵入式 FIFO 中 O(1) 摘掉指定等待任务。 */
export function removeRetryJob(job: TelegramOutboundJob): boolean {
  if (job.state !== "retryQueued") return false;
  const lane: TelegramRetryLane = laneFor(job.category);
  const previous: TelegramOutboundJob | null = job.previous;
  const next: TelegramOutboundJob | null = job.next;
  if (previous === null) lane.head = next;
  else previous.next = next;
  if (next === null) lane.tail = previous;
  else next.previous = previous;
  job.previous = null;
  job.next = null;
  job.state = "settled";
  telegramOutboundGateState.retryPendingCount--;
  lane.pendingCount--;
  return true;
}

/** 取出一个类别的 FIFO 队首并切换成 active。 */
export function takeRetryHead(
  lane: TelegramRetryLane
): TelegramOutboundJob | null {
  const job: TelegramOutboundJob | null = lane.head;
  if (job === null) return null;
  const next: TelegramOutboundJob | null = job.next;
  lane.head = next;
  if (next === null) lane.tail = null;
  else next.previous = null;
  job.previous = null;
  job.next = null;
  job.state = "active";
  telegramOutboundGateState.retryPendingCount--;
  lane.pendingCount--;
  return job;
}
