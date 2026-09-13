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

/**
 * 按接纳序号把任务插入侵入式 FIFO；达到全局硬顶时不修改状态。
 *
 * 队列始终按 admissionSeq 升序。新接纳的任务序号最大，O(1) 接到尾部；在途任务
 * 收到 429 重排时插回第一个比它晚接纳的等待任务之前（队首取出的探测任务回到
 * 队首）。从队首向后扫描：排在它之前的只可能是与它同时在途、先一步重排的任务。
 */
export function enqueueRetryJob(job: TelegramOutboundJob): boolean {
  if (
    telegramOutboundGateState.retryPendingCount >=
    TELEGRAM_429_RETRY_QUEUE_MAX
  ) return false;
  const lane: TelegramRetryLane = laneFor(job.category);
  const tail: TelegramOutboundJob | null = lane.tail;
  let next: TelegramOutboundJob | null = null;
  if (tail !== null && tail.admissionSeq > job.admissionSeq) {
    next = lane.head;
    while (next !== null && next.admissionSeq < job.admissionSeq) next = next.next;
  }
  const previous: TelegramOutboundJob | null = next === null ? tail : next.previous;
  job.previous = previous;
  job.next = next;
  if (previous === null) lane.head = job;
  else previous.next = job;
  if (next === null) lane.tail = job;
  else next.previous = job;
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
