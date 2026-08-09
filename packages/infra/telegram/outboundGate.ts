import type { RawApi, Transformer } from "grammy";
import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../cache/main/telegram";
import {
  TELEGRAM_429_FALLBACK_RETRY_MS,
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
import type { TelegramProjectRawMethod } from "../../types/telegramWorker";
import { TelegramRetryPreconditionChangedError } from "./errors";
import { isTelegramMessageRequest } from "./messageThrottler";

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

/** 429 退避队列拒绝错误；安全动作的 durable owner 收到后保留原任务并重投。 */
export class TelegramRetryQueueFullError extends Error {
  constructor() {
    super(`Telegram 429 retry queue reached its ${TELEGRAM_429_RETRY_QUEUE_MAX} request limit.`);
    this.name = "TelegramRetryQueueFullError";
  }
}

/**
 * 按业务语义选择独立的 429 域。高频调用都走 switch 的稳定分支；前缀兜底只
 * 服务未在项目调用面出现的新 Bot API，避免它意外与已有安全动作共享冷却。
 */
export function telegramRetryCategoryFor(
  method: keyof RawApi | TelegramProjectRawMethod
): TelegramRetryCategory {
  if (method === "deleteEphemeralMessage") return "delete";
  if (isTelegramMessageRequest(method)) return "message";
  switch (method) {
    case "answerInlineQuery":
    case "answerWebAppQuery":
    case "savePreparedInlineMessage":
      return "inline";
    case "getFile":
      return "download";
    case "banChatMember":
    case "kickChatMember":
    case "banChatSenderChat":
    case "unbanChatMember":
    case "unbanChatSenderChat":
      return "kick";
    case "restrictChatMember":
    case "setChatPermissions":
    case "promoteChatMember":
    case "setChatAdministratorCustomTitle":
      return "restrict";
    case "deleteMessage":
    case "deleteMessages":
    case "deleteBusinessMessages":
      return "delete";
    case "sendChatAction":
      return "chatAction";
    case "setMessageReaction":
    case "deleteMessageReaction":
    case "deleteAllMessageReactions":
      return "reaction";
    case "answerCallbackQuery":
    case "answerPreCheckoutQuery":
    case "answerShippingQuery":
      return "callback";
    case "getChat":
    case "getChatAdministrators":
    case "getChatMember":
    case "getStickerSet":
    case "getUserProfilePhotos":
      return "query";
    default:
      break;
  }
  const name: string = method;
  if (name.startsWith("get")) return "query";
  if (name.startsWith("edit") || method === "stopPoll") return "edit";
  if (
    name.includes("ProfilePhoto") ||
    name.startsWith("setMyName") ||
    name.startsWith("setMyDescription") ||
    name.startsWith("setMyShortDescription")
  ) return "profile";
  if (
    name.startsWith("setMy") ||
    name.startsWith("deleteMy") ||
    name.includes("Webhook") ||
    name.includes("ForumTopic") ||
    name.includes("InviteLink")
  ) return "management";
  return "other";
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

/**
 * 429 退避的下限：非正数一律回落到统一兜底值。
 *
 * 零延迟重试就是对着一个刚刚说过 429 的服务端空转——实测持续 429 时 300ms 内能
 * 打出近三百次请求（正常兜底是两次）。零可以从三条路进来，其中两条完全合法：
 * 空或纯空白的 `Retry-After:` 头（`Number("")` 是 0，绕过 null 兜底）、RFC 9110
 * 允许的 `Retry-After: 0`、以及已经过去的 HTTP-date。三条都收在这里。
 */
function clampRetryDelay(delayMs: number): number {
  return delayMs > 0 ? delayMs : TELEGRAM_429_FALLBACK_RETRY_MS;
}

function retryAfterMilliseconds(response: unknown): number | undefined {
  if (response instanceof Response) {
    if (response.status !== 429) return undefined;
    const retryAfter: string | null = response.headers.get("retry-after");
    if (retryAfter === null) return TELEGRAM_429_FALLBACK_RETRY_MS;
    const seconds: number = Number(retryAfter);
    // 空串与纯空白都会被 Number 归成 0，必须先排除，否则它们会伪装成
    // 「服务端明确说了 0 秒」而不是「这个头没法解析」。
    if (retryAfter.trim().length > 0 && Number.isFinite(seconds) && seconds >= 0) {
      return clampRetryDelay(Math.ceil(seconds * 1_000));
    }
    const retryAt: number = Date.parse(retryAfter);
    return Number.isFinite(retryAt)
      ? clampRetryDelay(retryAt - Date.now())
      : TELEGRAM_429_FALLBACK_RETRY_MS;
  }
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== false ||
    !("error_code" in response) ||
    response.error_code !== 429
  ) return undefined;
  if (
    !("parameters" in response) ||
    typeof response.parameters !== "object" ||
    response.parameters === null ||
    !("retry_after" in response.parameters)
  ) return TELEGRAM_429_FALLBACK_RETRY_MS;
  const retryAfterSeconds: unknown = response.parameters.retry_after;
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds < 0
  ) return TELEGRAM_429_FALLBACK_RETRY_MS;
  return clampRetryDelay(Math.ceil(retryAfterSeconds * 1_000));
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

function handleActiveResponse(job: TelegramOutboundJob, response: unknown): void {
  if (job.state !== "active") {
    if (response instanceof Response) {
      void response.body?.cancel().catch((): void => undefined);
    }
    return;
  }
  const retryAfterMs: number | undefined = retryAfterMilliseconds(response);
  if (retryAfterMs === undefined) {
    resolveActiveJob(job, response);
    return;
  }
  const lane: TelegramRetryLane = releaseActiveJob(job);
  if (job.signal?.aborted === true) {
    job.state = "settled";
    detachAbortListener(job);
    job.reject(abortReason());
  } else if (appendRetryJob(job)) {
    if (response instanceof Response) {
      void response.body?.cancel().catch((): void => undefined);
    }
  } else {
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
  if (job.signal?.aborted === true) {
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
    if (job.signal?.aborted === true) {
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
    const job: TelegramOutboundJob = {
      signal: jobSignal,
      previous: null,
      next: null,
      category,
      state: "created",
      fromRetryQueue: false,
      abortListener: undefined,
      beforeRetry: undefined,
      call: execute,
      resolve: resolve as (value: unknown) => void,
      reject,
    };
    job.abortListener = (): void => abortJob(job);
    job.signal.addEventListener("abort", job.abortListener, { once: true });
    enqueueOrStart(job, allowDuringQuiesce);
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
      const job: TelegramOutboundJob = {
        signal: jobSignal,
        previous: null,
        next: null,
        category,
        state: "created",
        fromRetryQueue: false,
        abortListener: undefined,
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
      };
      job.abortListener = (): void => abortJob(job);
      job.signal.addEventListener("abort", job.abortListener, { once: true });
      enqueueOrStart(job);
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
