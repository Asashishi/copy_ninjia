/**
 * 主线程每聊天发送调度器。出站闸（./outboundGate.ts）把发送类请求（isTelegramMessageRequest）交到
 * 这里，其余类别仍走按类别的 429 退避。按 Telegram FAQ 的公开限额主动控速，三层额度都满足才发出：
 * - 单聊天令牌桶：每 TELEGRAM_SEND_CHAT_REFILL_MS 补一个，容量 TELEGRAM_SEND_CHAT_BURST（保守档为 1）；
 * - 群类聊天（负数 id 与 `@username`）：任意 TELEGRAM_SEND_GROUP_WINDOW_MS 内不超过 TELEGRAM_SEND_GROUP_LIMIT 条；
 * - 全局：任意 TELEGRAM_SEND_GLOBAL_WINDOW_MS 内不超过 TELEGRAM_SEND_GLOBAL_LIMIT 条。
 * 相册按张数、批量复制/转发按条数扣额度；单次条数超过桶容量时等桶满后放行，余下欠额顺延，
 * 窗口按其容量封顶记账。
 *
 * 每个聊天一条 FIFO、最多 1 条在途，保持同一聊天的发送顺序；只差全局额度的车道进全局轮转队列
 * 依次放行。收到 429 只冻结这个聊天 retry_after，冻结结束后 TELEGRAM_SEND_CHAT_CAUTIOUS_MS 内
 * 突发容量降为 1，期间再 429 则顺延。额度在真正发出时才扣，排队中取消 O(1) 出队、不扣额度。
 *
 * 计数口径与出站闸一致：已接纳、未结算的任务（含等额度的）计入 activeCount 与 message 类的
 * activeCount；因 429 在聊天 FIFO 里等待重发的任务改计入 retryPendingCount 与 message 类的
 * pendingCount，重新发出时计回在途。运行态见 cache/main/telegramSend.ts。
 * @see ../../../docs/cn/04-invariants.md
 */

import type { RawApi } from "grammy";
import { telegramOutboundGateState } from "../../cache/main/telegram";
import {
  sendChatLanes,
  sendGlobalRing,
  sendGlobalWindow,
  sendSchedulerState,
} from "../../cache/main/telegramSend";
import {
  TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX,
  TELEGRAM_MESSAGE_GROUP_PENDING_MAX,
  TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX,
  TELEGRAM_SEND_CHAT_BURST,
  TELEGRAM_SEND_CHAT_CAUTIOUS_MS,
  TELEGRAM_SEND_CHAT_REFILL_MS,
  TELEGRAM_SEND_GLOBAL_LIMIT,
  TELEGRAM_SEND_GLOBAL_WINDOW_MS,
  TELEGRAM_SEND_GROUP_LIMIT,
  TELEGRAM_SEND_GROUP_WINDOW_MS,
} from "../../consts/telegram";
import { toErrorOr } from "../../libs/errorMessage";
import { TimestampDeque } from "../../libs/timestampDeque";
import type {
  TelegramOutboundJob,
  TelegramRetryLane,
  TelegramSendChatKey,
  TelegramSendLane,
} from "../../types/telegramOutbound";
import {
  abortReason,
  detachAbortListener,
  releaseResponseBody,
  settleDrainWaitersIfIdle,
} from "./outboundSettle";
import { telegramRetryAfterMilliseconds } from "./outboundRetryPolicy";

/** 发送排队已满：单个聊天或全部聊天合计的排队上限，新请求当即拒绝。 */
export class TelegramSendQueueFullError extends Error {
  constructor(scope: "chat" | "global") {
    super(
      scope === "chat"
        ? "Telegram send queue for this chat is full."
        : `Telegram send queue reached its ${TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX} request limit.`
    );
    this.name = "TelegramSendQueueFullError";
  }
}

function messageLane(): TelegramRetryLane {
  return telegramOutboundGateState.lanes.message;
}

/** payload.chat_id 的聊天键：数字原样，`@username` 小写，数字字符串转成数字。 */
function sendChatKeyOf(chatId: unknown): TelegramSendChatKey {
  if (typeof chatId === "number") return chatId;
  if (typeof chatId !== "string") return "";
  const trimmed: string = chatId.trim();
  if (trimmed.startsWith("@")) return trimmed.toLowerCase();
  const numeric: number = Number(trimmed);
  return trimmed.length > 0 && Number.isSafeInteger(numeric) ? numeric : trimmed;
}

/** 一次发送扣的额度条数：相册按张数、批量复制/转发按条数，其余为 1。 */
function sendCostOf(method: keyof RawApi, payload: unknown): number {
  let units: unknown;
  if (method === "sendMediaGroup") units = (payload as { media?: unknown }).media;
  else if (method === "copyMessages" || method === "forwardMessages") {
    units = (payload as { message_ids?: unknown }).message_ids;
  } else return 1;
  return Array.isArray(units) && units.length > 0 ? units.length : 1;
}

function laneForKey(key: TelegramSendChatKey, now: number): TelegramSendLane {
  const existing: TelegramSendLane | undefined = sendChatLanes.get(key);
  if (existing !== undefined) return existing;
  const groupClass: boolean = typeof key === "string" || key < 0;
  const lane: TelegramSendLane = {
    key,
    groupClass,
    head: null,
    tail: null,
    queued: 0,
    inFlight: null,
    tokens: TELEGRAM_SEND_CHAT_BURST,
    tokensAt: now,
    minuteWindow: groupClass ? new TimestampDeque(TELEGRAM_SEND_GROUP_LIMIT) : null,
    frozenUntil: 0,
    cautiousUntil: 0,
    lastSendAt: 0,
    timer: null,
    inGlobalRing: false,
  };
  sendChatLanes.set(key, lane);
  return lane;
}

function isLaneLive(lane: TelegramSendLane): boolean {
  return sendChatLanes.get(lane.key) === lane;
}

function appendQueued(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  job.previous = lane.tail;
  job.next = null;
  if (lane.tail === null) lane.head = job;
  else lane.tail.next = job;
  lane.tail = job;
  job.state = "sendQueued";
  lane.queued++;
  sendSchedulerState.queuedTotal++;
}

/** 已接纳任务计入在途；429 等待中的任务改计 429 等待。 */
function countActive(delta: number): void {
  telegramOutboundGateState.activeCount += delta;
  messageLane().activeCount += delta;
}

function countRetryPending(delta: number): void {
  telegramOutboundGateState.retryPendingCount += delta;
  messageLane().pendingCount += delta;
}

/** 429 后放回队首并改计 429 等待；不受排队上限约束（任务早已接纳）。 */
function prependRetryQueued(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  job.previous = null;
  job.next = lane.head;
  if (lane.head === null) lane.tail = job;
  else lane.head.previous = job;
  lane.head = job;
  job.state = "sendQueued";
  lane.queued++;
  sendSchedulerState.queuedTotal++;
  job.fromRetryQueue = true;
  countActive(-1);
  countRetryPending(1);
}

function removeQueued(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  const previous: TelegramOutboundJob | null = job.previous;
  const next: TelegramOutboundJob | null = job.next;
  if (previous === null) lane.head = next;
  else previous.next = next;
  if (next === null) lane.tail = previous;
  else next.previous = previous;
  job.previous = null;
  job.next = null;
  lane.queued--;
  sendSchedulerState.queuedTotal--;
}

/** 已接纳任务的结算记账（按它此刻计在哪一边扣减）；调用方随后 resolve 或 reject。 */
function settleSendJob(job: TelegramOutboundJob): void {
  if (job.fromRetryQueue) {
    job.fromRetryQueue = false;
    countRetryPending(-1);
  } else {
    countActive(-1);
  }
  telegramOutboundGateState.activeJobs.delete(job);
  job.state = "settled";
  detachAbortListener(job);
}

function clearLaneTimer(lane: TelegramSendLane): void {
  if (lane.timer === null) return;
  clearTimeout(lane.timer);
  lane.timer = null;
}

function onLaneTimer(lane: TelegramSendLane): void {
  lane.timer = null;
  if (isLaneLive(lane)) pumpSendLane(lane, false);
}

/** 本车道唯一定时器改到 at；每次被挡下最多重挂一次。 */
function armLaneTimer(lane: TelegramSendLane, at: number, now: number): void {
  clearLaneTimer(lane);
  lane.timer = setTimeout(onLaneTimer, Math.max(0, Math.ceil(at - now)), lane);
  lane.timer.unref();
}

/**
 * 空闲车道：分钟窗口、保守档与冻结都已结束时删除，否则挂一个到期复查的定时器。已有定时器
 * 时不重挂，它到点后复查并按新的到期时刻续挂。
 */
function retireIdleLane(lane: TelegramSendLane, now: number): void {
  const expiresAt: number = Math.max(
    lane.lastSendAt + TELEGRAM_SEND_GROUP_WINDOW_MS,
    lane.cautiousUntil,
    lane.frozenUntil
  );
  if (expiresAt > now) {
    if (lane.timer === null) armLaneTimer(lane, expiresAt, now);
    return;
  }
  clearLaneTimer(lane);
  sendChatLanes.delete(lane.key);
}

/** 当前突发容量：保守档内为 1。 */
function chatBurst(lane: TelegramSendLane, now: number): number {
  return now < lane.cautiousUntil ? 1 : TELEGRAM_SEND_CHAT_BURST;
}

/** 单聊天两层额度（令牌桶与群类分钟窗口）都满足的最早时刻；已满足时返回 now。 */
function chatReadyAt(lane: TelegramSendLane, cost: number, now: number): number {
  const burst: number = chatBurst(lane, now);
  if (lane.tokens < burst) {
    lane.tokens = Math.min(burst, lane.tokens + (now - lane.tokensAt) / TELEGRAM_SEND_CHAT_REFILL_MS);
  } else if (lane.tokens > burst) {
    lane.tokens = burst;
  }
  lane.tokensAt = now;
  // 超过桶容量的单次请求等桶满即放行。
  const needed: number = Math.min(cost, burst);
  let readyAt: number = lane.tokens < needed
    ? now + (needed - lane.tokens) * TELEGRAM_SEND_CHAT_REFILL_MS
    : now;
  const window: TimestampDeque | null = lane.minuteWindow;
  if (window !== null) {
    window.trim(TELEGRAM_SEND_GROUP_WINDOW_MS, now);
    const excess: number = window.size + Math.min(cost, TELEGRAM_SEND_GROUP_LIMIT) - TELEGRAM_SEND_GROUP_LIMIT;
    if (excess > 0) {
      readyAt = Math.max(readyAt, (window.peekAt(excess - 1) ?? now) + TELEGRAM_SEND_GROUP_WINDOW_MS);
    }
  }
  return readyAt;
}

/** 全局秒窗口容得下 cost 条的最早时刻；已满足时返回 now。 */
function globalReadyAt(cost: number, now: number): number {
  sendGlobalWindow.trim(TELEGRAM_SEND_GLOBAL_WINDOW_MS, now);
  const excess: number = sendGlobalWindow.size + Math.min(cost, TELEGRAM_SEND_GLOBAL_LIMIT) - TELEGRAM_SEND_GLOBAL_LIMIT;
  return excess > 0
    ? (sendGlobalWindow.peekAt(excess - 1) ?? now) + TELEGRAM_SEND_GLOBAL_WINDOW_MS
    : now;
}

function pushUnits(window: TimestampDeque, units: number, now: number): void {
  for (let index: number = 0; index < units; index++) window.push(now);
}

/** 发出前扣三层额度；令牌可扣成负数，窗口按容量封顶记账。 */
function consumeQuota(lane: TelegramSendLane, cost: number, now: number): void {
  lane.tokens -= cost;
  if (lane.minuteWindow !== null) pushUnits(lane.minuteWindow, Math.min(cost, TELEGRAM_SEND_GROUP_LIMIT), now);
  pushUnits(sendGlobalWindow, Math.min(cost, TELEGRAM_SEND_GLOBAL_LIMIT), now);
  lane.lastSendAt = now;
}

function armGlobalTimer(now: number): void {
  if (sendSchedulerState.globalTimer !== null) return;
  const lane: TelegramSendLane | undefined = sendGlobalRing.peek();
  const cost: number = lane?.head?.sendCost ?? 1;
  sendSchedulerState.globalTimer = setTimeout(
    onGlobalTimer,
    Math.max(0, Math.ceil(globalReadyAt(cost, now) - now))
  );
  sendSchedulerState.globalTimer.unref();
}

function joinGlobalRing(lane: TelegramSendLane, now: number): void {
  clearLaneTimer(lane);
  if (!lane.inGlobalRing) {
    lane.inGlobalRing = true;
    sendGlobalRing.push(lane);
  }
  armGlobalTimer(now);
}

/** 全局额度腾出后按轮转顺序放行：每条车道一次只放一条，额度不够时续挂定时器。 */
function onGlobalTimer(): void {
  sendSchedulerState.globalTimer = null;
  if (telegramOutboundGateState.aborting) return;
  for (;;) {
    const lane: TelegramSendLane | undefined = sendGlobalRing.peek();
    if (lane === undefined) return;
    const job: TelegramOutboundJob | null = lane.head;
    const now: number = performance.now();
    if (job !== null && isLaneLive(lane) && globalReadyAt(job.sendCost, now) > now) {
      armGlobalTimer(now);
      return;
    }
    sendGlobalRing.shift();
    lane.inGlobalRing = false;
    if (isLaneLive(lane)) pumpSendLane(lane, true);
  }
}

/** 网络结算后释放车道的在途位；调用方取消过的任务也要等到这一刻。 */
function releaseInFlight(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  if (lane.inFlight === job) lane.inFlight = null;
}

function afterSendSettled(lane: TelegramSendLane): void {
  if (isLaneLive(lane)) pumpSendLane(lane, false);
  settleDrainWaitersIfIdle();
}

/** 收到 429：只冻结这个聊天，冻结结束后进入保守档；保守档内再 429 则顺延。 */
function freezeLane(lane: TelegramSendLane, retryAfterMs: number): void {
  const frozenUntil: number = performance.now() + retryAfterMs;
  if (frozenUntil > lane.frozenUntil) lane.frozenUntil = frozenUntil;
  lane.cautiousUntil = lane.frozenUntil + TELEGRAM_SEND_CHAT_CAUTIOUS_MS;
}

function handleSendResponse(lane: TelegramSendLane, job: TelegramOutboundJob, response: unknown): void {
  releaseInFlight(lane, job);
  const retryAfterMs: number | undefined = telegramRetryAfterMilliseconds(response);
  if (retryAfterMs !== undefined && isLaneLive(lane)) freezeLane(lane, retryAfterMs);
  if (job.state !== "active") {
    releaseResponseBody(response);
  } else if (retryAfterMs === undefined) {
    settleSendJob(job);
    job.resolve(response);
  } else {
    // 回到本聊天队首，由下一次尝试自己拿新响应，这一份丢弃。
    releaseResponseBody(response);
    prependRetryQueued(lane, job);
  }
  afterSendSettled(lane);
}

function handleSendFailure(lane: TelegramSendLane, job: TelegramOutboundJob, error: unknown): void {
  releaseInFlight(lane, job);
  if (job.state === "active") {
    settleSendJob(job);
    job.reject(error);
  }
  afterSendSettled(lane);
}

function startSendJob(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  lane.inFlight = job;
  job.state = "active";
  let request: Promise<unknown>;
  try {
    request = job.call(job.signal);
  } catch (error: unknown) {
    handleSendFailure(lane, job, toErrorOr(error, "Telegram outbound call threw."));
    return;
  }
  void request.then(
    (response: unknown): void => handleSendResponse(lane, job, response),
    (error: unknown): void => handleSendFailure(lane, job, error)
  );
}

/**
 * 推进一条车道：队首额度齐备就扣额度并发出，否则按最先解除的约束挂车道定时器或进全局轮转。
 * fromRing 为 true 时由全局轮转调用，不再让位给其它排队车道。
 */
function pumpSendLane(lane: TelegramSendLane, fromRing: boolean): void {
  if (telegramOutboundGateState.aborting || lane.inFlight !== null || lane.inGlobalRing) return;
  const job: TelegramOutboundJob | null = lane.head;
  const now: number = performance.now();
  if (job === null) {
    retireIdleLane(lane, now);
    return;
  }
  if (now < lane.frozenUntil) {
    armLaneTimer(lane, lane.frozenUntil, now);
    return;
  }
  const readyAt: number = chatReadyAt(lane, job.sendCost, now);
  if (readyAt > now) {
    armLaneTimer(lane, readyAt, now);
    return;
  }
  if ((!fromRing && sendGlobalRing.size > 0) || globalReadyAt(job.sendCost, now) > now) {
    joinGlobalRing(lane, now);
    return;
  }
  clearLaneTimer(lane);
  consumeQuota(lane, job.sendCost, now);
  removeQueued(lane, job);
  if (job.fromRetryQueue) {
    job.fromRetryQueue = false;
    countRetryPending(-1);
    countActive(1);
  }
  startSendJob(lane, job);
}

/**
 * 接纳一条发送类请求：按 payload.chat_id 归入聊天车道并计入出站计数，额度齐备时同步发出。
 * 单聊天或全局排队已满时以 TelegramSendQueueFullError 拒绝，不计数。调用方在构造任务的同一
 * 同步片段里已判过接纳状态与信号。
 */
export function admitSendJob(job: TelegramOutboundJob, method: keyof RawApi, payload: unknown): void {
  const lane: TelegramSendLane = laneForKey(
    sendChatKeyOf((payload as { chat_id?: unknown } | null | undefined)?.chat_id),
    performance.now()
  );
  const laneMax: number = lane.groupClass ? TELEGRAM_MESSAGE_GROUP_PENDING_MAX : TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX;
  if (lane.queued >= laneMax || sendSchedulerState.queuedTotal >= TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX) {
    detachAbortListener(job);
    job.state = "settled";
    job.reject(new TelegramSendQueueFullError(lane.queued >= laneMax ? "chat" : "global"));
    if (lane.head === null && lane.inFlight === null) retireIdleLane(lane, performance.now());
    return;
  }
  job.sendLane = lane;
  job.sendCost = sendCostOf(method, payload);
  countActive(1);
  telegramOutboundGateState.activeJobs.add(job);
  appendQueued(lane, job);
  pumpSendLane(lane, false);
}

/**
 * 取消一条已接纳的发送任务（sendQueued 或 active）：排队中 O(1) 出队、不扣额度；在途的立即
 * 结算给调用方，车道在途位保留到网络结算。全局取消进行中不推进车道。
 */
export function abortSendJob(job: TelegramOutboundJob): void {
  const lane: TelegramSendLane | null = job.sendLane;
  if (job.state === "settled" || lane === null) return;
  if (job.state === "sendQueued") removeQueued(lane, job);
  settleSendJob(job);
  job.reject(abortReason());
  if (isLaneLive(lane)) pumpSendLane(lane, false);
  settleDrainWaitersIfIdle();
}

/**
 * 清空调度器：全部车道定时器、全局定时器、轮转队列与额度窗口。出站生命周期全局取消（任务
 * 已由各自的 abort 监听结算）与重新初始化时调用；在途请求之后结算时找不到车道，不再推进。
 */
export function resetSendScheduler(): void {
  for (const lane of sendChatLanes.values()) clearLaneTimer(lane);
  sendChatLanes.clear();
  sendGlobalRing.clear();
  if (sendSchedulerState.globalTimer !== null) clearTimeout(sendSchedulerState.globalTimer);
  sendSchedulerState.globalTimer = null;
  sendSchedulerState.queuedTotal = 0;
  sendGlobalWindow.clear();
}
