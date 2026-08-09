import { GrammyError } from "grammy";
import { superviseWorker } from "./supervisedWorker";
import type {
  WorkerDuplexCancel,
  WorkerDuplexInbound,
  WorkerDuplexOutbound,
  WorkerDuplexRequest,
  WorkerDuplexResponse,
} from "../types/workerDuplex";
import type {
  SupervisedWorkerEventContext,
  SupervisedWorkerHandle,
  SupervisedWorkerOptions,
} from "./supervisedWorker";

function isWorkerDuplexRequest<TRequest>(
  value: unknown
): value is WorkerDuplexRequest<TRequest> {
  return value !== null && typeof value === "object" &&
    "__duplex" in value && value.__duplex === "request" &&
    "requestId" in value && typeof value.requestId === "number" &&
    "request" in value;
}

function isWorkerDuplexCancel(value: unknown): value is WorkerDuplexCancel {
  return value !== null && typeof value === "object" &&
    "__duplex" in value && value.__duplex === "cancel" &&
    "requestId" in value && typeof value.requestId === "number";
}

/** 主线程能力处理器；signal 在 Worker 代际失效或单请求取消时中止。 */
export type WorkerCapabilityHandler<TRequest> = (
  request: TRequest,
  signal: AbortSignal
) => Promise<unknown>;

export interface SupervisedDuplexWorkerOptions<TMessage, TEvent, TRequest>
  extends Omit<
    SupervisedWorkerOptions<WorkerDuplexInbound<TMessage>, WorkerDuplexOutbound<TRequest> | TEvent>,
    "onEvent" | "onRespawn"
  > {
  readonly onEvent?: (event: TEvent) => void;
  readonly onRespawn?: (post: (message: TMessage) => boolean) => void;
  readonly handleRequest: WorkerCapabilityHandler<TRequest>;
  /** 成功回执中可转移的大缓冲；只允许返回 value 自身拥有且主线程不再使用的 buffer。 */
  readonly responseTransfer?: (
    request: TRequest,
    value: unknown
  ) => Bun.Transferable[] | undefined;
}

/** 把 Worker 业务事件与反向能力请求收敛进同一个受监督双工边界。 */
export function superviseDuplexWorker<TMessage, TEvent, TRequest>(
  options: SupervisedDuplexWorkerOptions<TMessage, TEvent, TRequest>
): SupervisedWorkerHandle<WorkerDuplexInbound<TMessage>> {
  const requestMaps: WeakMap<AbortSignal, Map<number, AbortController>> = new WeakMap();
  return superviseWorker<
    WorkerDuplexInbound<TMessage>,
    WorkerDuplexOutbound<TRequest> | TEvent
  >({
    url: options.url,
    label: options.label,
    giveUpConsequence: options.giveUpConsequence,
    onGiveUp: options.onGiveUp,
    onRespawn: options.onRespawn === undefined
      ? undefined
      : (post: (message: WorkerDuplexInbound<TMessage>) => boolean): void => options.onRespawn!(
        (message: TMessage): boolean => post(message)
      ),
    onEvent: (
      data: WorkerDuplexOutbound<TRequest> | TEvent,
      context: SupervisedWorkerEventContext<WorkerDuplexInbound<TMessage>>
    ): void => {
      if (isWorkerDuplexCancel(data)) {
        requestMaps.get(context.signal)?.get(data.requestId)?.abort();
        return;
      }
      if (!isWorkerDuplexRequest<TRequest>(data)) {
        options.onEvent?.(data);
        return;
      }
      let requests: Map<number, AbortController> | undefined =
        requestMaps.get(context.signal);
      if (requests === undefined) {
        requests = new Map();
        requestMaps.set(context.signal, requests);
      }
      const previous: AbortController | undefined = requests.get(data.requestId);
      if (previous !== undefined) previous.abort();
      const controller: AbortController = new AbortController();
      requests.set(data.requestId, controller);
      const signal: AbortSignal = AbortSignal.any([
        context.signal,
        controller.signal,
      ]);
      let execution: Promise<unknown>;
      try {
        execution = options.handleRequest(data.request, signal);
      } catch (error: unknown) {
        execution = Promise.reject(
          error instanceof Error ? error : new Error("Worker capability handler threw.")
        );
      }
      void execution.then(
        (value: unknown): void => {
          if (signal.aborted) return;
          const response: WorkerDuplexResponse = {
            __duplex: "response",
            requestId: data.requestId,
            ok: true,
            value,
            error: undefined,
          };
          let transfer: Bun.Transferable[] | undefined;
          try {
            transfer = options.responseTransfer?.(data.request, value);
          } catch (error: unknown) {
            context.post({
              __duplex: "response",
              requestId: data.requestId,
              ok: false,
              value: undefined,
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: "Main-thread capability response transfer failed.",
                telegramErrorCode: undefined,
                telegramDescription: undefined,
              },
            });
            return;
          }
          context.post(response, transfer);
        },
        (error: unknown): void => {
          if (signal.aborted) return;
          const telegramError: GrammyError | undefined =
            error instanceof GrammyError ? error : undefined;
          context.post({
            __duplex: "response",
            requestId: data.requestId,
            ok: false,
            value: undefined,
            error: {
              name: error instanceof Error ? error.name : "Error",
              // 普通 Error.message 可能含 Telegram 文件 URL（也就含 token）。
              // 只有 GrammyError.description 是 Bot API 返回的安全诊断字段。
              message: telegramError?.description ??
                "Main-thread capability request failed.",
              telegramErrorCode: telegramError?.error_code,
              telegramDescription: telegramError?.description,
            },
          });
        }
      ).finally((): void => {
        if (requests.get(data.requestId) === controller) {
          requests.delete(data.requestId);
        }
      });
    },
  });
}
