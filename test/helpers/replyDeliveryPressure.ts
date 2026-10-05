import { REPLY_DELIVERY_MAX_PER_CHAT, REPLY_DELIVERY_MAX_TOTAL, REPLY_TRIGGER_QUEUE_MAX } from "../../packages/consts/aiChat/rateLimit";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { invalidateChatReplyCache, replyDeliveryCounts, replyDeliveryTotal, replyDeliveryWindows, resetAiChatReplyCache } from "../../packages/cache/workers/aiChat/replies";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import { admitTrigger, replyRoundConcurrencyLimit } from "../../packages/states/replyAdmission";
import type { ReplyDeliveryTurn } from "../../packages/types/aiChat/replies";
import type { AdmitDecision } from "../../packages/types/states/replyAdmission";

/** 压力夹具直接调用的生产发送顺位与容量边界。 */
export interface DeliveryApi {
  readonly reserveReplyDelivery: (chatId: number) => ReplyDeliveryTurn | undefined;
  readonly hasReplyDeliveryCapacity: (chatId: number) => boolean;
  readonly isDirectReplyModelActive: (chatId: number) => boolean;
}

interface LoadRound {
  readonly id: number;
  readonly chatId: number;
  readonly arrivedAt: number;
  readonly telegramBackpressured: boolean;
  turn: ReplyDeliveryTurn | undefined;
  startedAt: number;
  modelFinishedAt: number;
  sentAt: number;
  modelActive: boolean;
  ready: boolean;
  sendFinished: boolean;
  cancelled: boolean;
  settled: boolean;
}

interface LoadEvent {
  readonly at: number;
  readonly kind: "arrival" | "model" | "finish" | "invalidate";
  readonly round: LoadRound | undefined;
  readonly chatId: number;
}

/** 固定服务耗时与虚拟时钟下的排队结果；这些毫秒数不包含真实 CPU、网络或定时器抖动。 */
export interface DeliveryPressureResult {
  readonly arrivals: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly retryWaits: number;
  readonly peakLive: number;
  readonly peakPerChat: number;
  readonly peakQueued: number;
  readonly peakChatQueued: number;
  readonly triggerWaitP95Ms: number;
  readonly triggerWaitP99Ms: number;
  readonly deliveryWaitP95Ms: number;
  readonly deliveryWaitP99Ms: number;
  readonly endToEndP95Ms: number;
  readonly endToEndP99Ms: number;
  readonly completedPerSecond: number;
  readonly trace: number;
}

/** 压力输入；容量和并发读取生产常量，服务耗时只由夹具决定。 */
export interface DeliveryPressureOptions {
  readonly delivery: DeliveryApi;
  readonly mode: "singleChat" | "multiChat" | "retryCancel";
}

function percentile(values: number[], fraction: number): number {
  values.sort((left: number, right: number): number => left - right);
  return values[Math.ceil(values.length * fraction) - 1] ?? 0;
}

/**
 * 固定到达序列下调用生产准入和发送边界，模型完成与发送耗时由事件时钟驱动。
 * retryCancel 以固定额外等待模拟 429 的占位时间，并让旧窗口取消后迟到 commit；
 * 发送前按夹具入站顺序核对同群前轮已完成或取消，顺序检查不读取被测队列。
 * 不发起模型或 Telegram 请求，也不替代出站重试与完整回复生命周期测试。
 */
export async function runReplyDeliveryPressure({ delivery, mode }: DeliveryPressureOptions): Promise<DeliveryPressureResult> {
  resetAiChatReplyCache();
  const chats: number = mode === "singleChat" ? 1 : STATE_MANAGED_CHAT_LIMIT;
  const arrivals: number = REPLY_DELIVERY_MAX_TOTAL * 32;
  const events: LoadEvent[] = [];
  const queues: Map<number, LinkedQueue<LoadRound>> = new Map<number, LinkedQueue<LoadRound>>();
  const active: Map<number, number> = new Map<number, number>();
  const rounds: Map<number, LoadRound> = new Map<number, LoadRound>();
  const triggerWaits: number[] = [];
  const deliveryWaits: number[] = [];
  const endToEnd: number[] = [];
  let now: number = 0;
  let completed: number = 0;
  let cancelled: number = 0;
  let rejected: number = 0;
  let retryWaits: number = 0;
  let peakLive: number = 0;
  let peakPerChat: number = 0;
  let peakQueued: number = 0;
  let peakChatQueued: number = 0;
  let trace: number = 0;
  let deliveryFailure: Error | undefined;

  function record(value: number): void {
    trace = (Math.imul(trace, 31) + value) | 0;
  }

  function schedule(event: LoadEvent): void {
    let low: number = 0;
    let high: number = events.length;
    while (low < high) {
      const middle: number = (low + high) >>> 1;
      if (events[middle]!.at <= event.at) low = middle + 1;
      else high = middle;
    }
    events.splice(low, 0, event);
  }

  function snapshotCapacity(): void {
    peakLive = Math.max(peakLive, replyDeliveryTotal.current);
    let queued: number = 0;
    for (const size of replyDeliveryCounts.values()) peakPerChat = Math.max(peakPerChat, size);
    for (const queue of queues.values()) {
      queued += queue.size;
      peakChatQueued = Math.max(peakChatQueued, queue.size);
    }
    peakQueued = Math.max(peakQueued, queued);
    if (peakLive > REPLY_DELIVERY_MAX_TOTAL || peakPerChat > REPLY_DELIVERY_MAX_PER_CHAT || peakChatQueued > REPLY_TRIGGER_QUEUE_MAX) {
      throw new Error("Reply pressure fixture escaped production capacity.");
    }
  }

  function pressuredAt(time: number): boolean {
    return mode === "retryCancel" && time >= 12 && time < 28;
  }

  function sendWhenReady(round: LoadRound): void {
    if (round.cancelled || !round.ready || round.modelActive || round.sentAt >= 0) return;
    for (const previous of rounds.values()) {
      if (previous === round) break;
      if (previous.chatId === round.chatId && !previous.cancelled && !previous.sendFinished) {
        deliveryFailure = new Error("Reply pressure fixture started a send before the preceding turn finished.");
        return;
      }
    }
    round.sentAt = now;
    const retry: number = mode === "retryCancel" && round.id % 17 === 0 ? 80 : 0;
    if (retry > 0) retryWaits++;
    record(round.id);
    record(round.sentAt);
    schedule({ at: now + 8 + round.id % 7 + retry, kind: "finish", round, chatId: round.chatId });
  }

  function start(round: LoadRound): void {
    const turn: ReplyDeliveryTurn | undefined = delivery.reserveReplyDelivery(round.chatId);
    if (turn === undefined) throw new Error("Reply pressure fixture reserved unavailable capacity.");
    round.turn = turn;
    round.startedAt = now;
    round.modelActive = true;
    active.set(round.chatId, (active.get(round.chatId) ?? 0) + 1);
    rounds.set(round.id, round);
    void turn.ready.then((): void => {
      round.ready = true;
      sendWhenReady(round);
    });
    const modelMs: number = round.id % 29 === 0 ? 180 : 1 + (round.id * 13) % 37;
    schedule({ at: now + modelMs, kind: "model", round, chatId: round.chatId });
    record(round.id);
    record(round.startedAt);
  }

  function drain(): void {
    for (const chatId of [...queues.keys()]) {
      const queue: LinkedQueue<LoadRound> = queues.get(chatId)!;
      const before: number = queue.size;
      while (queue.size > 0 && delivery.hasReplyDeliveryCapacity(chatId) &&
        (active.get(chatId) ?? 0) < replyRoundConcurrencyLimit(queue.peek()!.telegramBackpressured, delivery.isDirectReplyModelActive(chatId))) {
        start(queue.shift()!);
      }
      if (queue.size === 0) queues.delete(chatId);
      else if (queue.size < before) {
        queues.delete(chatId);
        queues.set(chatId, queue);
      }
    }
    snapshotCapacity();
  }

  function finish(round: LoadRound): void {
    round.sendFinished = true;
    void round.turn!.finish().then((): void => {
      if (round.settled) throw new Error("Reply pressure fixture released a turn twice.");
      round.settled = true;
      rounds.delete(round.id);
      if (round.cancelled) cancelled++;
      else {
        completed++;
        triggerWaits.push(round.startedAt - round.arrivedAt);
        deliveryWaits.push(round.sentAt - round.modelFinishedAt);
        endToEnd.push(now - round.arrivedAt);
      }
      record(round.id);
      record(now);
      drain();
    });
  }

  for (let id: number = 0; id < arrivals; id++) {
    const arrivedAt: number = Math.floor(id / (chats * 4));
    const round: LoadRound = {
      id, chatId: -1 - id % chats, arrivedAt, telegramBackpressured: pressuredAt(arrivedAt), turn: undefined,
      startedAt: -1, modelFinishedAt: -1, sentAt: -1, modelActive: false, ready: false, sendFinished: false, cancelled: false, settled: false,
    };
    schedule({ at: round.arrivedAt, kind: "arrival", round, chatId: round.chatId });
  }
  if (mode === "retryCancel") {
    for (let chat: number = 0; chat < chats; chat += 2) schedule({ at: 35, kind: "invalidate", round: undefined, chatId: -1 - chat });
  }

  while (events.length > 0) {
    const event: LoadEvent = events.shift()!;
    now = event.at;
    const round: LoadRound | undefined = event.round;
    if (event.kind === "arrival") {
      const decision: AdmitDecision = admitTrigger({
        activeRounds: active.get(event.chatId) ?? 0,
        queueSize: queues.get(event.chatId)?.size ?? 0,
        kind: round!.id % 5 === 0 ? "random" : "direct",
        telegramBackpressured: round!.telegramBackpressured,
        directRoundActive: delivery.isDirectReplyModelActive(event.chatId),
        deliveryAvailable: delivery.hasReplyDeliveryCapacity(event.chatId),
      });
      if (decision === "startRound") start(round!);
      else if (decision === "enqueue") {
        let queue: LinkedQueue<LoadRound> | undefined = queues.get(event.chatId);
        if (queue === undefined) { queue = new LinkedQueue<LoadRound>(); queues.set(event.chatId, queue); }
        queue.push(round!);
      } else rejected++;
      record(decision.length);
      snapshotCapacity();
    } else if (event.kind === "model") {
      if (!round!.modelActive) round!.turn!.commit();
      else {
        round!.modelActive = false;
        round!.modelFinishedAt = now;
        active.set(event.chatId, active.get(event.chatId)! - 1);
        round!.turn!.commit();
        sendWhenReady(round!);
        drain();
      }
    } else if (event.kind === "finish") {
      if (!round!.cancelled) finish(round!);
    } else {
      invalidateChatReplyCache(event.chatId);
      const queue: LinkedQueue<LoadRound> | undefined = queues.get(event.chatId);
      cancelled += queue?.size ?? 0;
      queues.delete(event.chatId);
      for (const owned of rounds.values()) {
        if (owned.chatId !== event.chatId || owned.cancelled) continue;
        owned.cancelled = true;
        if (owned.modelActive) {
          owned.modelActive = false;
          active.set(event.chatId, active.get(event.chatId)! - 1);
        }
        finish(owned);
      }
      drain();
    }
    for (let tick: number = 0; tick < 3; tick++) await Promise.resolve();
    if (deliveryFailure !== undefined) throw deliveryFailure;
  }
  if (queues.size !== 0 || rounds.size !== 0 || replyDeliveryTotal.current !== 0 || replyDeliveryCounts.size !== 0 || replyDeliveryWindows.size !== 0) {
    throw new Error("Reply pressure fixture retained unfinished work.");
  }
  if (completed + cancelled + rejected !== arrivals) throw new Error("Reply pressure fixture lost arrivals.");
  return {
    arrivals, completed, cancelled, rejected, retryWaits, peakLive, peakPerChat, peakQueued, peakChatQueued,
    triggerWaitP95Ms: percentile(triggerWaits, 0.95), triggerWaitP99Ms: percentile(triggerWaits, 0.99),
    deliveryWaitP95Ms: percentile(deliveryWaits, 0.95), deliveryWaitP99Ms: percentile(deliveryWaits, 0.99),
    endToEndP95Ms: percentile(endToEnd, 0.95), endToEndP99Ms: percentile(endToEnd, 0.99),
    completedPerSecond: completed / now * 1_000, trace,
  };
}
