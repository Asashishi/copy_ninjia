import type { RawApi, Transformer } from "grammy";
import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../cache/main/telegram";
import {
  TELEGRAM_429_RECOVERY_MAX_CONCURRENT,
  TELEGRAM_429_RETRY_QUEUE_MAX,
  TELEGRAM_TIMER_MAX_DELAY_MS,
} from "../../consts/telegram";
import type { FlushResult } from "../../types/lifecycle";
import type {
  TelegramOutboundDrainWaiter,
  TelegramOutboundJob,
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../types/telegramOutbound";
import { TelegramRetryPreconditionChangedError } from "./errors";
import {
  telegramRetryAfterMilliseconds,
  telegramRetryCategoryFor,
  TelegramRetryQueueFullError,
} from "./outboundRetryPolicy";

type PreviousCall = Parameters<Transformer<RawApi>>[0];
type UnbanChatMemberPayload = Parameters<RawApi["unbanChatMember"]>[0];

function isRawSuccess(response: unknown): response is Readonly<{
  ok: true;
  result: Readonly<{ status: string }>;
}> {
  return typeof response === "object" && response !== null &&
    "ok" in response && response.ok === true &&
    "result" in response && typeof response.result === "object" &&
    response.result !== null && "status" in response.result &&
    typeof response.result.status === "string";
}

/**
 * 超级群的纯踢出由不带 only_if_banned 的 unbanChatMember 实现。一次 429 等待
 * 足以让人工管理员在期间封禁目标，所以每次重放前都必须重新确认目标仍在群；
 * 否则重放会把人工封禁解除。
 */
async function revalidateUnbanKickRetry(
  previous: PreviousCall,
  payload: UnbanChatMemberPayload,
  signal: AbortSignal
): Promise<void> {
  const response: unknown = await runTelegramCategorizedRequestInternal({
    category: "query",
    signal,
    execute: (requestSignal: AbortSignal): Promise<unknown> => previous("getChatMember", {
      chat_id: payload.chat_id,
      user_id: payload.user_id,
    }, requestSignal as never),
  }, true);
  if (!isRawSuccess(response)) {
    throw new Error("Telegram kick retry membership revalidation failed.");
  }
  switch (response.result.status) {
    case "creator":
    case "administrator":
    case "member":
    case "restricted":
      return;
    case "left":
    case "kicked":
      throw new TelegramRetryPreconditionChangedError();
    default:
      throw new Error("Telegram kick retry returned an unknown member status.");
  }
}

function laneFor(category: TelegramRetryCategory): TelegramRetryLane {
  return telegramOutboundGateState.lanes[category];
}

function appendRetryJob(job: TelegramOutboundJob): boolean {
  if (telegramOutboundGateState.retryPendingCount >= TELEGRAM_429_RETRY_QUEUE_MAX) {
    return false;
  }
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

function removeRetryJob(job: TelegramOutboundJob): boolean {
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

function takeRetryHead(lane: TelegramRetryLane): TelegramOutboundJob | null {
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

function settleDrainWaitersIfIdle(): void {
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

function detachAbortListener(job: TelegramOutboundJob): void {
  if (job.abortListener === undefined) return;
  job.signal.removeEventListener("abort", job.abortListener);
  job.abortListener = undefined;
}

function abortReason(): Error {
  return new DOMException("Telegram outbound request was aborted.", "AbortError");
}

/** 把调用方取消与当前出站 owner 代际合并，并把生命周期信号传到真实网络层。 */
function outboundSignal(signal: AbortSignal | undefined): AbortSignal {
  const lifecycleSignal: AbortSignal =
    telegramOutboundAbortController.current.signal;
  if (signal === undefined || signal === lifecycleSignal) return lifecycleSignal;
  return AbortSignal.any([signal, lifecycleSignal]);
}

function scheduleRetryTimer(
  category: TelegramRetryCategory,
  lane: TelegramRetryLane
): void {
  const remainingMs: number = Math.max(
    0,
    Math.ceil(lane.retryAt - performance.now())
  );
  const delayMs: number = Math.min(remainingMs, TELEGRAM_TIMER_MAX_DELAY_MS);
  const timer: ReturnType<typeof setTimeout> = setTimeout(
    onRetryTimer,
    delayMs,
    category
  );
  timer.unref();
  lane.retryTimer = timer;
}

function onRetryTimer(category: TelegramRetryCategory): void {
  const lane: TelegramRetryLane = laneFor(category);
  lane.retryTimer = null;
  if (telegramOutboundAbortController.current.signal.aborted) {
    lane.retryAt = 0;
    lane.recovering = false;
    lane.recoveryLimit = 1;
    settleDrainWaitersIfIdle();
    return;
  }
  if (lane.retryAt > performance.now()) {
    scheduleRetryTimer(category, lane);
    return;
  }
  lane.retryAt = 0;
  lane.recovering = true;
  pumpRetryLane(lane);
}

function extendRetry(
  category: TelegramRetryCategory,
  retryAfterMs: number
): void {
  const lane: TelegramRetryLane = laneFor(category);
  const retryAt: number = performance.now() + retryAfterMs;
  if (
    lane.retryTimer !== null &&
    retryAt <= lane.retryAt
  ) return;
  lane.retryAt = retryAt;
  lane.recovering = true;
  lane.recoveryLimit = 1;
  if (lane.retryTimer !== null) {
    clearTimeout(lane.retryTimer);
    lane.retryTimer = null;
  }
  scheduleRetryTimer(category, lane);
}

function releaseActiveJob(job: TelegramOutboundJob): TelegramRetryLane {
  const lane: TelegramRetryLane = laneFor(job.category);
  telegramOutboundGateState.activeJobs.delete(job);
  telegramOutboundGateState.activeCount--;
  lane.activeCount--;
  if (job.fromRetryQueue) {
    lane.recoveryActive--;
    job.fromRetryQueue = false;
  }
  return lane;
}

function resetRecoveryIfIdle(lane: TelegramRetryLane): void {
  if (
    lane.head !== null ||
    lane.recoveryActive !== 0
  ) return;
  if (lane.retryTimer !== null) {
    if (
      telegramOutboundAccepting.current &&
      !telegramOutboundAbortController.current.signal.aborted
    ) return;
    clearTimeout(lane.retryTimer);
    lane.retryTimer = null;
  }
  lane.retryAt = 0;
  lane.recovering = false;
  lane.recoveryLimit = 1;
}

function resolveActiveJob(job: TelegramOutboundJob, response: unknown): void {
  if (job.state !== "active") {
    if (response instanceof Response) {
      void response.body?.cancel().catch((): void => undefined);
    }
    return;
  }
  const wasRecovery: boolean = job.fromRetryQueue;
  const lane: TelegramRetryLane = releaseActiveJob(job);
  job.state = "settled";
  detachAbortListener(job);
  job.resolve(response);
  if (
    wasRecovery &&
    lane.retryTimer === null &&
    lane.recoveryLimit < TELEGRAM_429_RECOVERY_MAX_CONCURRENT
  ) lane.recoveryLimit++;
  pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

function rejectActiveJob(job: TelegramOutboundJob, error: unknown): void {
  if (job.state !== "active") return;
  const lane: TelegramRetryLane = releaseActiveJob(job);
  job.state = "settled";
  detachAbortListener(job);
  job.reject(error);
  pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/** 从 created/active/retryQueued 任一阶段只结算一次取消。 */
function abortJob(job: TelegramOutboundJob): void {
  if (job.state === "settled") return;
  const lane: TelegramRetryLane = laneFor(job.category);
  if (job.state === "retryQueued") {
    removeRetryJob(job);
  } else if (job.state === "active") {
    releaseActiveJob(job);
    job.state = "settled";
  } else {
    job.state = "settled";
  }
  detachAbortListener(job);
  job.reject(abortReason());
  if (!telegramOutboundGateState.aborting) pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/**
 * 释放不再交给调用方的响应体。
 *
 * `telegramRetryAfterMilliseconds` 只读 header，不消费 body；被它判成 429 之后
 * 又不往外交的那些响应，如果就这么丢掉，body 会一直占着连接与缓冲——正是
 * telegram/workerRequests.ts 里「不读取错误页，但要显式释放响应体」防的那件事。
 * 只有 fetch 那条路（媒体下载、头像抓取）拿得到真正的 Response；grammY
 * transformer 那条路返回的是已解析的 Bot API 对象，这里恒为 no-op。
 */
function releaseResponseBody(response: unknown): void {
  if (response instanceof Response) {
    void response.body?.cancel().catch((): void => undefined);
  }
}

function handleActiveResponse(job: TelegramOutboundJob, response: unknown): void {
  if (job.state !== "active") {
    releaseResponseBody(response);
    return;
  }
  const retryAfterMs: number | undefined = telegramRetryAfterMilliseconds(response);
  if (retryAfterMs === undefined) {
    resolveActiveJob(job, response);
    return;
  }
  const lane: TelegramRetryLane = releaseActiveJob(job);
  if (job.signal.aborted) {
    // 调用方在 429 回来的同时取消了（下载超时与退避撞在一起就是这个形态）：
    // 这条响应既不重排也不外交，body 必须在这里释放。
    releaseResponseBody(response);
    job.state = "settled";
    detachAbortListener(job);
    job.reject(abortReason());
  } else if (appendRetryJob(job)) {
    // 重排进队后由下一次尝试自己拿新响应，这一份丢弃。
    releaseResponseBody(response);
  } else {
    // 队列已满：原样把 429 交给调用方，body 的所有权随之转移，这里不能释放。
    job.state = "settled";
    detachAbortListener(job);
    job.resolve(response);
  }
  extendRetry(job.category, retryAfterMs);
  pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

function executeActiveJob(job: TelegramOutboundJob): void {
  if (job.state !== "active") return;
  let request: Promise<unknown>;
  try {
    request = job.call(job.signal);
  } catch (error: unknown) {
    rejectActiveJob(
      job,
      error instanceof Error ? error : new Error("Telegram outbound call threw.")
    );
    return;
  }
  void request.then(
    (response: unknown): void => handleActiveResponse(job, response),
    (error: unknown): void => rejectActiveJob(job, error)
  );
}

function startJob(job: TelegramOutboundJob, fromRetryQueue: boolean): void {
  const lane: TelegramRetryLane = laneFor(job.category);
  job.state = "active";
  job.fromRetryQueue = fromRetryQueue;
  telegramOutboundGateState.activeCount++;
  lane.activeCount++;
  telegramOutboundGateState.activeJobs.add(job);
  if (fromRetryQueue) lane.recoveryActive++;
  if (job.signal.aborted) {
    releaseActiveJob(job);
    job.state = "settled";
    detachAbortListener(job);
    job.reject(abortReason());
    pumpRetryLane(lane);
    resetRecoveryIfIdle(lane);
    settleDrainWaitersIfIdle();
    return;
  }
  if (fromRetryQueue && job.beforeRetry !== undefined) {
    let precondition: Promise<void>;
    try {
      precondition = job.beforeRetry();
    } catch (error: unknown) {
      rejectActiveJob(job, error);
      return;
    }
    void precondition.then(
      (): void => executeActiveJob(job),
      (error: unknown): void => rejectActiveJob(job, error)
    );
    return;
  }
  executeActiveJob(job);
}

function pumpRetryLane(lane: TelegramRetryLane): void {
  if (telegramOutboundGateState.aborting) return;
  if (lane.retryTimer !== null || !lane.recovering) return;
  while (lane.recoveryActive < lane.recoveryLimit) {
    const job: TelegramOutboundJob | null = takeRetryHead(lane);
    if (job === null) break;
    if (job.signal.aborted) {
      job.state = "settled";
      detachAbortListener(job);
      job.reject(abortReason());
      continue;
    }
    startJob(job, true);
  }
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

function enqueueOrStart(
  job: TelegramOutboundJob,
  allowDuringQuiesce: boolean = false
): void {
  if (
    (!telegramOutboundAccepting.current && !allowDuringQuiesce) ||
    job.signal.aborted
  ) {
    detachAbortListener(job);
    job.state = "settled";
    job.reject(abortReason());
    return;
  }
  const lane: TelegramRetryLane = laneFor(job.category);
  if (
    lane.retryTimer !== null ||
    lane.recovering ||
    lane.head !== null
  ) {
    if (appendRetryJob(job)) return;
    detachAbortListener(job);
    job.state = "settled";
    job.reject(new TelegramRetryQueueFullError());
    return;
  }
  startJob(job, false);
}

/** createOutboundJob 的入参：一次出站请求里随调用点变化的六个字段。 */
interface CreateOutboundJobOptions {
  readonly signal: AbortSignal;
  readonly category: TelegramRetryCategory;
  /** 仅破坏性请求传入；其余类别恒为 undefined。 */
  readonly beforeRetry: (() => Promise<void>) | undefined;
  readonly call: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * 出站 job 的唯一构造点：按固定顺序一次初始化全部字段，再挂上一次性 abort
 * 监听。每条出站请求都经过这里，字段集合与顺序不得在调用点各自展开。
 */
function createOutboundJob({
  signal,
  category,
  beforeRetry,
  call,
  resolve,
  reject,
}: CreateOutboundJobOptions): TelegramOutboundJob {
  const job: TelegramOutboundJob = {
    signal,
    previous: null,
    next: null,
    category,
    state: "created",
    fromRetryQueue: false,
    abortListener: undefined,
    beforeRetry,
    call,
    resolve,
    reject,
  };
  job.abortListener = (): void => abortJob(job);
  job.signal.addEventListener("abort", job.abortListener, { once: true });
  return job;
}

export interface TelegramCategorizedRequestOptions<T> {
  readonly category: TelegramRetryCategory;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
}

/** 分类请求的唯一构造点；quiesce 例外只供本文件内已接纳请求的前置复核。 */
function runTelegramCategorizedRequestInternal<T>({
  category,
  execute,
  signal,
}: TelegramCategorizedRequestOptions<T>, allowDuringQuiesce: boolean): Promise<T> {
  if (!telegramOutboundAccepting.current && !allowDuringQuiesce) {
    return Promise.reject(abortReason());
  }
  const jobSignal: AbortSignal = outboundSignal(signal);
  if (jobSignal.aborted) return Promise.reject(abortReason());
  return new Promise<T>((
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    enqueueOrStart(createOutboundJob({
      signal: jobSignal,
      category,
      beforeRetry: undefined,
      call: execute,
      resolve: resolve as (value: unknown) => void,
      reject,
    }), allowDuringQuiesce);
  });
}

/**
 * 让 Telegram 文件 CDN 等非 Bot API HTTP 请求复用同一组分类型 429 队列。
 * execute 只能发起一次尝试；返回 429 时调度器会在对应域内重新调用它。
 */
export function runTelegramCategorizedRequest<T>(
  options: TelegramCategorizedRequestOptions<T>
): Promise<T> {
  return runTelegramCategorizedRequestInternal(options, false);
}

/**
 * 主线程唯一 Telegram 429 闸门。正常请求直接执行，不猜固定速率；某一类别真实
 * 收到 429 后，仅该类别按 retry_after 排队并渐进恢复。发送类仍由下游 grammY
 * throttler 先执行 Telegram 官方公开的主动限流。
 */
export function telegramOutboundGate(): Transformer<RawApi> {
  // grammY 的 transformer 固定为四参数泛型回调，参数类型由 Transformer 完整约束。
  // eslint-disable-next-line @typescript-eslint/typedef, @typescript-eslint/explicit-function-return-type, max-params
  const transformer: Transformer<RawApi> = (previous, method, payload, signal) => {
    // getUpdates 是入站长轮询，不属于任何出站退避域。
    if (method === "getUpdates") return previous(method, payload, signal);
    if (!telegramOutboundAccepting.current) return Promise.reject(abortReason());
    const jobSignal: AbortSignal = outboundSignal(signal as AbortSignal | undefined);
    if (jobSignal.aborted) return Promise.reject(abortReason());
    const category: TelegramRetryCategory = telegramRetryCategoryFor(method);
    // resolve 的实际泛型由上面的 Transformer 上下文给出，grammY 未公开 Payload。
    // eslint-disable-next-line @typescript-eslint/typedef
    return new Promise((resolve, reject): void => {
      enqueueOrStart(createOutboundJob({
        signal: jobSignal,
        category,
        beforeRetry: method === "unbanChatMember" &&
            (payload as UnbanChatMemberPayload).only_if_banned !== true
          ? (): Promise<void> => revalidateUnbanKickRetry(
            previous,
            payload as UnbanChatMemberPayload,
            jobSignal
          )
          : undefined,
        call: (requestSignal: AbortSignal): Promise<unknown> =>
          previous(method, payload, requestSignal as never),
        resolve: resolve as (value: unknown) => void,
        reject,
      }));
    });
  };
  return transformer;
}

/**
 * 为新一轮应用生命周期重新武装出站 owner。旧一代必须已经完全结算；否则拒绝
 * 初始化，不能用清零计数掩盖仍可能迟到回调的网络任务。
 */
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
    throw new Error("Cannot initialize Telegram outbound while the previous lifecycle is unsettled.");
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

/** 预算耗尽后的全局取消：真实网络、429 timer、队列和调用方 promise 一并结算。 */
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

/** drainTelegramOutbound 的可选项。 */
export interface DrainTelegramOutboundOptions {
  /**
   * 排空前是否关闭入口。默认 true（真正的停机收尾）。
   *
   * **确认最终 offset 之前那次排空必须传 false**：闸门一旦关闭就只能由
   * `initTelegramClients` 重新武装，而 `wait()` 之后 `dispose()` 还要再排空一遍
   * gag 提示、延迟删除与 anti-raid 播报——那些收尾全都要发 Telegram 请求，撞上
   * 已关闭的闸门只会拿到 AbortError，于是提示永远留在群里、owner 永远结算不掉。
   * 关闭时机因此收在 dispose() 自己的 Telegram owner 那一步（见
   * app/lifecycle/shutdown.ts 的 SHUTDOWN_DRAIN_OWNERS），它本来就排在上述收尾
   * 之后。getUpdates 全程豁免于本闸门，最终 offset 确认不受影响。
   *
   * 传 false 也只免掉「进门就关」：预算耗尽时仍按 docs/cn/04-invariants.md 的
   * 约束走 abort（它自带 quiesce）。那一档本来就是「出站已经超预算」，此时停止
   * 发送才是契约，后续收尾拿不到闸门属于既定降级。
   */
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
  return new Promise<FlushResult>((resolve: (result: FlushResult) => void): void => {
    const waiter: TelegramOutboundDrainWaiter = {
      resolve: (drained: boolean): void => resolve(drained ? "flushed" : "timedOut"),
      timer: setTimeout((): void => {
        if (!telegramOutboundGateState.drainWaiters.delete(waiter)) return;
        abortTelegramOutbound();
        resolve("timedOut");
      }, timeoutMs),
    };
    telegramOutboundGateState.drainWaiters.add(waiter);
  });
}
