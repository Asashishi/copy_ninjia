import {
  workerDuplexPoster,
  workerDuplexRequestCounter,
  workerDuplexWaiters,
} from "../cache/perThread/workerDuplex";
import type {
  WorkerDuplexError,
  WorkerDuplexOutbound,
  WorkerDuplexResponse,
} from "../types/workerDuplex";
import type { WorkerDuplexWaiter } from "../cache/perThread/workerDuplex";

/** 主线程能力请求失败后在 Worker 侧重建的安全错误。 */
export class WorkerDuplexRemoteError extends Error {
  readonly telegramErrorCode: number | undefined;
  readonly telegramDescription: string | undefined;

  constructor(error: WorkerDuplexError) {
    super(error.message);
    this.name = error.name;
    this.telegramErrorCode = error.telegramErrorCode;
    this.telegramDescription = error.telegramDescription;
  }
}

/** 判断一条 Worker 入站消息是不是双工回执。 */
export function isWorkerDuplexResponse(value: unknown): value is WorkerDuplexResponse {
  return value !== null && typeof value === "object" &&
    "__duplex" in value && value.__duplex === "response" &&
    "requestId" in value && typeof value.requestId === "number";
}

/** 在 Worker 启动入口注入唯一的 postMessage 出口。 */
export function initializeWorkerDuplex<TRequest>(
  poster: (
    message: WorkerDuplexOutbound<TRequest>,
    transfer?: Bun.Transferable[]
  ) => void
): void {
  workerDuplexPoster.current = poster as (
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void;
}

function abortError(): Error {
  return new DOMException("Worker duplex request was aborted.", "AbortError");
}

/**
 * Worker 请求主线程执行一项能力。等待者先登记后 post，保证同步测试回执也不会
 * 丢；取消时用独立 cancel 信封撤销主线程排队/在途工作。
 */
export function requestMainThread<TRequest, TResult>(
  request: TRequest,
  signal?: AbortSignal,
  transfer?: Bun.Transferable[]
): Promise<TResult> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  const poster: ((
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void) | null =
    workerDuplexPoster.current;
  if (poster === null) {
    return Promise.reject(new Error("Worker duplex transport is not initialized."));
  }
  if (workerDuplexRequestCounter.current >= Number.MAX_SAFE_INTEGER) {
    return Promise.reject(new Error("Worker duplex request id exhausted."));
  }
  const requestId: number = ++workerDuplexRequestCounter.current;
  return new Promise<TResult>((
    resolve: (value: TResult | PromiseLike<TResult>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const abortListener: (() => void) | undefined = signal === undefined
      ? undefined
      : (): void => {
        if (!workerDuplexWaiters.delete(requestId)) return;
        try {
          poster({ __duplex: "cancel", requestId });
        } catch {
          // 本地 waiter 已经结算；Worker 退出会由主线程代际 signal 再兜一次。
        }
        reject(abortError());
      };
    const waiter: WorkerDuplexWaiter = {
      resolve: (value: unknown): void => resolve(value as TResult),
      reject,
      signal,
      abortListener,
    };
    workerDuplexWaiters.set(requestId, waiter);
    if (abortListener !== undefined) {
      signal!.addEventListener("abort", abortListener, { once: true });
    }
    try {
      poster({ __duplex: "request", requestId, request }, transfer);
    } catch (error: unknown) {
      workerDuplexWaiters.delete(requestId);
      if (abortListener !== undefined) signal!.removeEventListener("abort", abortListener);
      reject(error instanceof Error ? error : new Error("Worker duplex post failed."));
    }
  });
}

/** Worker onmessage 的双工回执分支；已取消请求的迟到回执直接丢弃。 */
export function handleWorkerDuplexResponse(response: WorkerDuplexResponse): void {
  const waiter: WorkerDuplexWaiter | undefined =
    workerDuplexWaiters.get(response.requestId);
  if (waiter === undefined) return;
  workerDuplexWaiters.delete(response.requestId);
  if (waiter.abortListener !== undefined) {
    waiter.signal!.removeEventListener("abort", waiter.abortListener);
  }
  if (response.ok) {
    waiter.resolve(response.value);
  } else {
    waiter.reject(new WorkerDuplexRemoteError(response.error ?? {
      name: "Error",
      message: "Main-thread capability request failed.",
      telegramErrorCode: undefined,
      telegramDescription: undefined,
    }));
  }
}

/** Worker 停止时结算本 isolate 的全部等待者。 */
export function resetWorkerDuplex(reason: string): void {
  workerDuplexPoster.current = null;
  const error: Error = new Error(reason);
  for (const waiter of workerDuplexWaiters.values()) {
    if (waiter.abortListener !== undefined) {
      waiter.signal!.removeEventListener("abort", waiter.abortListener);
    }
    waiter.reject(error);
  }
  workerDuplexWaiters.clear();
}
