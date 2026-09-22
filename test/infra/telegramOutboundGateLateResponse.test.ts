/**
 * 出站闸的取消路径：任务取消之后才回来的响应（outboundGate.ts 的
 * handleActiveResponse 非 active 分支与「在途但 signal 已中止」分支）、入队前已中止
 * 的 signal、429 重放前置条件同步抛错，以及生命周期 signal 已中止后 retry timer
 * 到点。只有 fetch 那条路（媒体下载、头像抓取）会拿到真正的 Response；没人接手的
 * 那一份 body 必须就地释放，否则连接与缓冲一直占着。
 */

import { afterEach, expect, test } from "bun:test";
import type { RawApi, Transformer } from "grammy";
import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../packages/cache/main/telegram";
import {
  runTelegramCategorizedRequest,
  telegramOutboundGate,
} from "../../packages/infra/telegram/outboundGate";
import { drainTelegramOutbound } from
  "../../packages/infra/telegram/outboundLifecycle";
import { enqueueRetryJob } from "../../packages/infra/telegram/outboundQueue";
import type {
  TelegramOutboundJob,
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../packages/types/telegramOutbound";
import { waitUntil } from "../helpers/waitUntil";

type PreviousCall = Parameters<Transformer<RawApi>>[0];

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

afterEach((): void => {
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
});

/** 一份带 body 的响应与它的释放观测。 */
interface ObservableResponse {
  readonly response: Response;
  readonly cancelled: () => boolean;
}

/** 造一份带 body 的响应，并记录 body 是否被释放。 */
function observableResponse(init: ResponseInit = { status: 200 }): ObservableResponse {
  const response: Response = new Response("payload", init);
  let cancelled: boolean = false;
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body !== null) {
    const originalCancel: (reason?: unknown) => Promise<void> = body.cancel.bind(body);
    body.cancel = async (reason?: unknown): Promise<void> => {
      cancelled = true;
      return originalCancel(reason);
    };
  }
  return { response, cancelled: (): boolean => cancelled };
}

interface InjectedRetryJobOptions {
  readonly signal: AbortSignal;
  readonly beforeRetry: (() => Promise<void>) | undefined;
  readonly call: (signal: AbortSignal) => Promise<unknown>;
}

/**
 * 绕过生产构造点，把一条**不挂 abort 监听**的 job 直接挂进 query 类别的 429 FIFO。
 * 生产入口构造的 job 都挂着 abort 监听，signal 一中止就同步结算；生产里唯一的
 * beforeRetry 又是 async 函数，不会同步抛出。startJob 与 handleActiveResponse
 * 里按 job 状态分支的那几段只能这样单独驱动。
 */
function injectQueryRetryJob({
  signal,
  beforeRetry,
  call,
}: InjectedRetryJobOptions): Promise<unknown> {
  return new Promise<unknown>((
    resolve: (value: unknown) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const job: TelegramOutboundJob = {
      signal,
      previous: null,
      next: null,
      admissionSeq: telegramOutboundGateState.nextAdmissionSeq++,
      category: "query",
      state: "created",
      fromRetryQueue: false,
      abortListener: undefined,
      beforeRetry,
      call,
      resolve,
      reject,
    };
    if (!enqueueRetryJob(job)) reject(new Error("Injected retry job was not queued."));
  });
}

/** 一条占住 query 类别的在途请求；`release` 让它以成功结算。 */
interface QueryLaneHold {
  readonly request: Promise<unknown>;
  readonly release: () => void;
}

/**
 * 先起一条直接执行的 query 请求并把类别切到恢复态；它结算时闸门按 FIFO 放行
 * 恢复队列里的下一条。
 */
function holdQueryLaneForRecovery(): QueryLaneHold {
  const pending: PromiseWithResolvers<unknown> = Promise.withResolvers<unknown>();
  const request: Promise<unknown> = runTelegramCategorizedRequest({
    category: "query",
    execute: (_signal: AbortSignal): Promise<unknown> => pending.promise,
  });
  telegramOutboundGateState.lanes.query.recovering = true;
  return {
    request,
    release: (): void => pending.resolve({ ok: true, result: "trigger" }),
  };
}

test("停机取消之后才回来的 200 响应，body 被释放而不是丢着", async () => {
  const late: ObservableResponse = observableResponse();
  let deliver: ((value: unknown) => void) | undefined;
  const request: Promise<unknown> = runTelegramCategorizedRequest({
    category: "download",
    execute: (): Promise<unknown> => new Promise<unknown>((resolve: (value: unknown) => void): void => {
      deliver = resolve;
    }),
  });

  await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
  await expect(request).rejects.toMatchObject({ name: "AbortError" });

  deliver?.(late.response);
  await Promise.resolve();
  await Promise.resolve();

  expect(late.cancelled()).toBeTrue();
  // 迟到的结算不得让计数复活。
  expect(telegramOutboundGateState.activeCount).toBe(0);
});

test("迟到的非 Response 结算不做任何释放动作，也不复活计数", async () => {
  let deliver: ((value: unknown) => void) | undefined;
  const request: Promise<unknown> = runTelegramCategorizedRequest({
    category: "query",
    execute: (): Promise<unknown> => new Promise<unknown>((resolve: (value: unknown) => void): void => {
      deliver = resolve;
    }),
  });

  await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
  await expect(request).rejects.toMatchObject({ name: "AbortError" });

  deliver?.({ ok: true, result: true });
  await Promise.resolve();
  await Promise.resolve();

  expect(telegramOutboundGateState.activeCount).toBe(0);
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
});

/**
 * 429 与调用方取消撞在一起时的响应体归属。那几处 fetch 调用都带超时 signal，
 * 「下载超时」与「返回 429」同时发生就是这条分支：abort 监听先把任务结算掉，
 * 随后回来的 429 既不重排也不外交，body 在闸门里释放。
 */
test("调用方已取消时收到 429：响应体被释放，任务不回到 429 队列", async () => {
  let attempts: number = 0;
  const controller: AbortController = new AbortController();
  const throttled: ObservableResponse = observableResponse({ status: 429, headers: { "retry-after": "1" } });

  const request: Promise<unknown> = runTelegramCategorizedRequest({
    category: "download",
    signal: controller.signal,
    execute: async (): Promise<unknown> => {
      attempts++;
      // 请求已发出、响应正在回来的那一刻调用方取消：先 abort 再交出 429。
      controller.abort();
      return throttled.response;
    },
  });

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  const downloadLane: TelegramRetryLane = telegramOutboundGateState.lanes.download;
  expect(throttled.cancelled()).toBeTrue();
  expect(attempts).toBe(1);
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  expect(downloadLane.head).toBeNull();
  expect(downloadLane.pendingCount).toBe(0);
  expect(telegramOutboundGateState.activeCount).toBe(0);
});

test("在途任务的 signal 已中止但尚未结算时收到 429：释放 body、以 AbortError 结算、不重排，仍按 retry_after 延长冷却", async () => {
  const queryLane: TelegramRetryLane = telegramOutboundGateState.lanes.query;
  const controller: AbortController = new AbortController();
  const pending: PromiseWithResolvers<unknown> = Promise.withResolvers<unknown>();
  let attempts: number = 0;
  const trigger: QueryLaneHold = holdQueryLaneForRecovery();
  const injected: Promise<unknown> = injectQueryRetryJob({
    signal: controller.signal,
    beforeRetry: undefined,
    call: (_signal: AbortSignal): Promise<unknown> => {
      attempts++;
      return pending.promise;
    },
  });
  const outcome: Promise<unknown> = injected.catch((error: unknown): unknown => error);

  trigger.release();
  await expect(trigger.request).resolves.toEqual({ ok: true, result: "trigger" });
  expect(attempts).toBe(1);
  expect(queryLane.recoveryActive).toBe(1);

  controller.abort();
  const throttled: ObservableResponse = observableResponse({ status: 429, headers: { "retry-after": "60" } });
  pending.resolve(throttled.response);

  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(throttled.cancelled()).toBeTrue();
  expect(attempts).toBe(1);
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  expect(telegramOutboundGateState.activeCount).toBe(0);
  expect(telegramOutboundGateState.activeJobs.size).toBe(0);
  expect(queryLane.head).toBeNull();
  expect(queryLane.recoveryActive).toBe(0);
  expect(queryLane.retryTimer).not.toBeNull();
});

test("入队前 signal 已中止：不构造任务、不调用 execute，直接以 AbortError 拒绝", async () => {
  let calls: number = 0;
  const execute = (_signal: AbortSignal): Promise<unknown> => {
    calls++;
    return Promise.resolve({ ok: true, result: true });
  };
  const previous: PreviousCall = ((): Promise<unknown> => {
    calls++;
    return Promise.resolve({ ok: true, result: true });
  }) as PreviousCall;
  const transform: Transformer<RawApi> = telegramOutboundGate();
  const admissionSeq: number = telegramOutboundGateState.nextAdmissionSeq;

  const caller: AbortController = new AbortController();
  caller.abort();
  await expect(runTelegramCategorizedRequest({
    category: "query",
    signal: caller.signal,
    execute,
  })).rejects.toMatchObject({ name: "AbortError" });
  await expect(transform(previous, "sendMessage", {
    chat_id: -1001,
    text: "cancelled before admission",
  }, caller.signal as never)).rejects.toMatchObject({ name: "AbortError" });

  // 入口仍在接纳、但当前生命周期代际已中止：同样在构造任务前拒绝。
  telegramOutboundAbortController.current.abort();
  await expect(runTelegramCategorizedRequest({
    category: "query",
    execute,
  })).rejects.toMatchObject({ name: "AbortError" });
  await expect(transform(previous, "sendMessage", {
    chat_id: -1001,
    text: "lifecycle already aborted",
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(calls).toBe(0);
  expect(telegramOutboundGateState.nextAdmissionSeq).toBe(admissionSeq);
  expect(telegramOutboundGateState.activeCount).toBe(0);
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  expect(telegramOutboundGateState.activeJobs.size).toBe(0);
});

test("排队任务出队时 signal 已中止：直接以 AbortError 结算、不调用 call，并继续放行下一条", async () => {
  const queryLane: TelegramRetryLane = telegramOutboundGateState.lanes.query;
  const cancelled: AbortController = new AbortController();
  let injectedCalls: number = 0;
  const trigger: QueryLaneHold = holdQueryLaneForRecovery();
  const injected: Promise<unknown> = injectQueryRetryJob({
    signal: cancelled.signal,
    beforeRetry: undefined,
    call: (_signal: AbortSignal): Promise<unknown> => {
      injectedCalls++;
      return Promise.resolve({ ok: true, result: "injected" });
    },
  });
  const injectedOutcome: Promise<unknown> = injected.catch((error: unknown): unknown => error);
  const follower: Promise<unknown> = runTelegramCategorizedRequest({
    category: "query",
    execute: (_signal: AbortSignal): Promise<unknown> =>
      Promise.resolve({ ok: true, result: "follower" }),
  });
  cancelled.abort();

  trigger.release();

  expect(await injectedOutcome).toMatchObject({ name: "AbortError" });
  await expect(follower).resolves.toEqual({ ok: true, result: "follower" });
  expect(injectedCalls).toBe(0);
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  expect(telegramOutboundGateState.activeCount).toBe(0);
  expect(queryLane.head).toBeNull();
  expect(queryLane.recoveryActive).toBe(0);
});

test("重放前置条件同步抛错：以原错误拒绝该任务、不发请求，并继续放行同类别下一条", async () => {
  const queryLane: TelegramRetryLane = telegramOutboundGateState.lanes.query;
  const preconditionError: Error = new Error("precondition check threw");
  let injectedCalls: number = 0;
  let followerCalls: number = 0;
  const trigger: QueryLaneHold = holdQueryLaneForRecovery();
  const injected: Promise<unknown> = injectQueryRetryJob({
    signal: new AbortController().signal,
    beforeRetry: (): Promise<void> => {
      throw preconditionError;
    },
    call: (_signal: AbortSignal): Promise<unknown> => {
      injectedCalls++;
      return Promise.resolve({ ok: true, result: "injected" });
    },
  });
  const injectedOutcome: Promise<unknown> = injected.catch((error: unknown): unknown => error);
  const follower: Promise<unknown> = runTelegramCategorizedRequest({
    category: "query",
    execute: (_signal: AbortSignal): Promise<unknown> => {
      followerCalls++;
      return Promise.resolve({ ok: true, result: "follower" });
    },
  });
  expect(telegramOutboundGateState.retryPendingCount).toBe(2);

  trigger.release();

  expect(await injectedOutcome).toBe(preconditionError);
  await expect(follower).resolves.toEqual({ ok: true, result: "follower" });
  await expect(trigger.request).resolves.toEqual({ ok: true, result: "trigger" });
  expect(injectedCalls).toBe(0);
  expect(followerCalls).toBe(1);
  expect(telegramOutboundGateState.activeCount).toBe(0);
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  expect(queryLane.head).toBeNull();
  expect(queryLane.recoveryActive).toBe(0);
  expect(queryLane.recovering).toBeFalse();
});

test("生命周期 signal 已中止后 retry timer 到点：lane 复位，不再放行队列里的任务", async () => {
  const queryLane: TelegramRetryLane = telegramOutboundGateState.lanes.query;
  const caller: AbortController = new AbortController();
  let attempts: number = 0;
  const request: Promise<unknown> = runTelegramCategorizedRequest({
    category: "query",
    signal: caller.signal,
    execute: (_signal: AbortSignal): Promise<unknown> => {
      attempts++;
      return Promise.resolve({ ok: false, error_code: 429, parameters: { retry_after: 0.005 } });
    },
  });
  const outcome: Promise<unknown> = request.catch((error: unknown): unknown => error);
  await Promise.resolve();
  await Promise.resolve();
  expect(queryLane.head).not.toBeNull();
  expect(queryLane.retryTimer).not.toBeNull();

  // 换代后中止当前生命周期 signal：排队任务挂在上一代 signal 上不会被连带取消，
  // timer 到点时只能靠生命周期检查拦住恢复。
  telegramOutboundAbortController.current = new AbortController();
  telegramOutboundAbortController.current.abort();

  expect(await waitUntil((): boolean => queryLane.retryTimer === null)).toBeTrue();
  expect(queryLane.retryAt).toBe(0);
  expect(queryLane.recovering).toBeFalse();
  expect(queryLane.recoveryLimit).toBe(1);
  expect(queryLane.head).not.toBeNull();
  expect(telegramOutboundGateState.retryPendingCount).toBe(1);
  expect(attempts).toBe(1);

  caller.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  expect(queryLane.head).toBeNull();
});
