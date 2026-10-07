/**
 * 可自愈的业务 Worker 宿主（主线程侧）骨架，由 infra/supervisedDuplexWorker.ts 包装后供
 * aiChat/workerBridge.ts 与 antiRaid/workerBridge/controller.ts 使用：
 * - 创建 Worker 并 unref（不阻止进程退出，停机时在途任务随线程丢弃）；
 * - 识别 Worker 回传的有界 error 日志批次（logger.ts 的转发模式），转投主线程
 *   唯一的落盘线程并确认该批；其余消息交给 onEvent（业务事件回传）；
 * - Worker 崩溃时按节流重建：Bun 在未捕获异常后已终止该 Worker 线程，这里不再
 *   terminate，直接换新实例顶上，并经 onRespawn 重放必要状态；
 * - 放弃自愈的节流阈值见 consts/workerSupervisor.ts；永久不可用时
 *   post() 返回 false，并通知 ApplicationLifecycle 停止 runner。投递边界
 *   把同步异常统一收敛为 false。
 */

import { logger } from "./logger";
import { relayLogMessage } from "./diskIO";
import { signalBusinessWorkerFatal } from "./workerSupervisor";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../consts/workerSupervisor";
import { createRestartThrottle } from "../libs/restartThrottle";
import type {
  ForwardedLogBatch,
  ForwardedLogBatchAccepted,
} from "../types/diskIO/messages";
import { toErrorOr } from "../libs/errorMessage";

/** superviseWorker 的配置：Worker 脚本、日志称呼、放弃自愈的后果说明与三个可选生命周期回调。 */
export interface SupervisedWorkerOptions<TMessage, TEvent> {
  /** Worker 脚本的 URL（new URL("...", import.meta.url).href）。 */
  url: string;
  /** 日志里称呼这个 Worker 的名字（如 "AI Worker"）。 */
  label: string;
  /** 永久不可用时，fatal 错误里点明受影响的业务能力。 */
  giveUpConsequence: string;
  /** 非日志信封的业务事件回传（如 antiRaid 的 lockdown/unlock 镜像同步）。
   *  data 按 TEvent 交付，不做运行期校验：信任 Worker 只回传声明过的事件类型。 */
  onEvent?: (
    data: TEvent,
    context: SupervisedWorkerEventContext<TMessage>
  ) => void;
  /** 新实例顶上后重放状态（如 aiChat 重放 init、antiRaid 重放 adopt）。
   *  FIFO 保证这里 post 的消息先于此后的一切投递到达新 Worker；任意一次
   *  同步拒绝都会在回调结束后撤销整个新实例，即使调用方忽略返回值。 */
  onRespawn?: (post: (message: TMessage) => boolean) => void;
  /** 永久不可用时的领域收尾（如 antiRaid 启动主线程紧急权限恢复）。 */
  onGiveUp?: () => void;
}

/** 当前 Worker 代际专属的回投与取消边界。 */
export interface SupervisedWorkerEventContext<TMessage> {
  /** 只回投产生本事件的实例；该实例已被替换时返回 false。 */
  readonly post: (message: TMessage, transfer?: Bun.Transferable[]) => boolean;
  /** 实例崩溃、被替换或显式终止时 abort。 */
  readonly signal: AbortSignal;
}

export interface SupervisedWorkerHandle<TMessage> {
  /** 显式启动 Worker；重复调用幂等。 */
  readonly init: () => void;
  /** 只向已初始化且仍可用的 Worker 投递；已提交返回 true，不可用或同步拒绝时返回 false。 */
  readonly post: (message: TMessage, transfer?: Bun.Transferable[]) => boolean;
  /** 停止当前实例并阻止迟到 onerror 触发自愈；重复调用幂等。 */
  readonly terminate: () => Promise<void>;
}

/**
 * 建立业务 Worker 的监督句柄，但不在模块导入时创建线程。入口完成单实例锁和
 * 必要的持久化恢复后，由领域 init 显式启动；永久不可用后拒绝投递并通知
 * 应用生命周期交给进程管理器重启。
 */
export function superviseWorker<TMessage, TEvent = never>(
  options: SupervisedWorkerOptions<TMessage, TEvent>
): SupervisedWorkerHandle<TMessage> {
  const restartThrottle: { shouldGiveUp: () => boolean; } = createRestartThrottle(WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS);
  let worker: Worker | null = null;
  let generationAbortController: AbortController | null = null;
  let initialized: boolean = false;

  function terminateFailedWorker(failedWorker: Worker): void {
    try {
      failedWorker.terminate();
    } catch (error: unknown) {
      logger.error(`${options.label} termination after failure rejected:`, error);
    }
  }

  function becomeUnavailable(failedWorker: Worker, failure: Error): void {
    if (worker !== failedWorker) return;
    worker = null;
    generationAbortController?.abort();
    generationAbortController = null;
    terminateFailedWorker(failedWorker);
    try {
      options.onGiveUp?.();
    } catch (error: unknown) {
      logger.error(`${options.label} unavailable cleanup failed:`, error);
    }
    signalBusinessWorkerFatal(failure);
  }

  function postToWorker(
    target: Worker,
    message: unknown,
    transfer?: Bun.Transferable[]
  ): boolean {
    try {
      if (transfer === undefined) target.postMessage(message);
      else target.postMessage(message, transfer);
      return true;
    } catch (error: unknown) {
      logger.error(`${options.label} postMessage failed:`, error);
      return false;
    }
  }

  function createWorker(): Worker {
    const w: Worker = new Worker(options.url);
    const controller: AbortController = new AbortController();
    generationAbortController = controller;
    w.unref();
    // 本代际全部业务事件共用的回投与取消边界；实例被替换后 post 恒返回 false。
    const eventContext: SupervisedWorkerEventContext<TMessage> = {
      post: (message: TMessage, transfer?: Bun.Transferable[]): boolean => {
        if (worker !== w) return false;
        if (postToWorker(w, message, transfer)) return true;
        becomeUnavailable(
          w,
          new Error(`${options.label} synchronous event response delivery was rejected.`)
        );
        return false;
      },
      signal: controller.signal,
    };
    w.onmessage = (event: MessageEvent<unknown>): void => {
      const data: unknown = event.data;
      // __logBatch 转发不受下面的活跃实例守卫约束：它只把这个 Worker 自己的
      // error 日志转投落盘线程，不改写共享镜像；旧实例的迟到日志同样转投。
      if (data && typeof data === "object" && "__logBatch" in data) {
        const forwarded: ForwardedLogBatch = data as ForwardedLogBatch;
        let acceptedAll: boolean = true;
        for (const message of forwarded.__logBatch.messages) {
          if (!relayLogMessage(message)) acceptedAll = false;
        }
        // DiskIO owner 未初始化时不回 ACK，原批留在 Worker 的待确认队列。
        if (!acceptedAll) return;
        const accepted: ForwardedLogBatchAccepted = {
          __logBatchAccepted: forwarded.__logBatch.batchId,
        };
        // ACK 被旧代际同步拒绝时，已收入主线程 FIFO 的原批不撤回，由主线程队列
        // 继续向 DiskIO 重投。
        postToWorker(w, accepted);
        return;
      }
      // 已被替换的旧实例迟到送达的业务事件丢弃（同 onerror 的守卫）。
      if (worker !== w) return;
      options.onEvent?.(data as TEvent, eventContext);
    };
    w.onerror = (event: ErrorEvent): void => {
      // 已被替换的旧实例迟到或重复上报的错误忽略。
      if (worker !== w) return;
      logger.error(`${options.label} errored, restarting:`, event.message || event.error || event);
      controller.abort();
      if (restartThrottle.shouldGiveUp()) {
        const failure: Error = new Error(
          `${options.label} restarted ${WORKER_MAX_RESTARTS} times within ` +
          `${WORKER_RESTART_WINDOW_MS / 1000}s; ${options.giveUpConsequence}`
        );
        logger.error(`${failure.message}`);
        becomeUnavailable(w, failure);
        return;
      }
      let next: Worker;
      try {
        next = createWorker();
      } catch (error: unknown) {
        const failure: Error = toErrorOr(error, `${options.label} replacement construction failed.`);
        logger.error(`${options.label} replacement construction failed:`, error);
        becomeUnavailable(w, failure);
        return;
      }
      worker = next;
      let replayFailure: Error | null = null;
      try {
        options.onRespawn?.((message: TMessage): boolean => {
          if (replayFailure !== null) return false;
          if (postToWorker(next, message)) return true;
          replayFailure = new Error(`${options.label} state replay was rejected.`);
          return false;
        });
      } catch (error: unknown) {
        replayFailure = toErrorOr(error, `${options.label} state replay failed.`);
        logger.error(`${options.label} state replay failed:`, error);
      }
      if (replayFailure !== null) {
        becomeUnavailable(next, replayFailure);
      }
    };
    return w;
  }

  function init(): void {
    if (initialized) return;
    worker = createWorker();
    initialized = true;
  }

  return {
    init,
    post: (message: TMessage, transfer?: Bun.Transferable[]): boolean => {
      const current: Worker | null = worker;
      if (current === null) return false;
      if (postToWorker(current, message, transfer)) return true;
      becomeUnavailable(current, new Error(`${options.label} synchronous message delivery was rejected.`));
      return false;
    },
    terminate: (): Promise<void> => {
      const current: Worker | null = worker;
      worker = null;
      generationAbortController?.abort();
      generationAbortController = null;
      initialized = false;
      if (current === null) return Promise.resolve();
      try {
        current.terminate();
        return Promise.resolve();
      } catch (error: unknown) {
        return Promise.reject(toErrorOr(error, "Worker termination failed."));
      }
    },
  };
}
