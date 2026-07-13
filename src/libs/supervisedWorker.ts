import { logger, relayLogMessage } from "../infra/logger";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../consts/workerSupervisor";
import { createRestartThrottle } from "./workerSupervisor";
import type { ForwardedLog } from "../types";

/**
 * 可自愈的业务 Worker 宿主（主线程侧），aiChat.ts 与 antiRaid.ts 共用的骨架：
 * - 创建 Worker 并 unref（不阻止进程退出，停机时在途任务随线程丢弃）；
 * - 识别 Worker 回传的 error 日志信封（logger.ts 的转发模式），转投主线程
 *   唯一的落盘线程；其余消息交给 onEvent（业务事件回传）；
 * - Worker 崩溃时按节流重建：Bun 里 Worker 内部一旦抛出未捕获异常（同步或
 *   async 均如此，已实测验证）就会直接终止该 Worker 线程，不需要（实际上
 *   也没法）手动 terminate，直接换新实例顶上，并经 onRespawn 重放必要状态；
 * - 短时间内反复崩溃（多半是代码本身有 bug，重启也没用）则放弃自愈：此后
 *   post() 安静地丢弃消息——不能再对已终止的 Worker postMessage（Bun 会
 *   同步抛 InvalidStateError）。
 */
export interface SupervisedWorkerOptions<TMessage, TEvent> {
  /** Worker 脚本的 URL（new URL("...", import.meta.url).href）。 */
  url: string;
  /** 日志里称呼这个 Worker 的名字（如 "AI Worker"）。 */
  label: string;
  /** 放弃自愈时，日志里点明的业务后果（哪个功能会静默失效到进程重启）。 */
  giveUpConsequence: string;
  /** 非日志信封的业务事件回传（如 antiRaid 的 lockdown/unlock 镜像同步）。
   *  data 按 TEvent 交付——与旧的内联 onmessage 一样，信任 Worker 只回传
   *  声明过的事件类型。 */
  onEvent?: (data: TEvent) => void;
  /** 新实例顶上后重放状态（如 aiChat 重放 init、antiRaid 重放 adopt）。
   *  FIFO 保证这里 post 的消息先于此后的一切投递到达新 Worker。 */
  onRespawn?: (post: (message: TMessage) => void) => void;
  /** 放弃自愈时的额外收尾（如 antiRaid 清空并点名镜像里的私密模式）。 */
  onGiveUp?: () => void;
}

/** 启动并监督一个业务 Worker，返回投递句柄（自愈放弃后投递被静默丢弃）。 */
export function superviseWorker<TMessage, TEvent = never>(
  options: SupervisedWorkerOptions<TMessage, TEvent>
): { post: (message: TMessage) => void } {
  const restartThrottle = createRestartThrottle(WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS);

  function createWorker(): Worker {
    const w: Worker = new Worker(options.url);
    w.unref();
    w.onmessage = (event: MessageEvent<unknown>) => {
      const data: unknown = event.data;
      if (data && typeof data === "object" && "__log" in data) {
        relayLogMessage((data as ForwardedLog).__log);
        return;
      }
      options.onEvent?.(data as TEvent);
    };
    w.onerror = (event: ErrorEvent) => {
      logger.error(`${options.label} errored, restarting:`, event.message || event.error || event);
      if (restartThrottle.shouldGiveUp()) {
        logger.error(
          `${options.label} restarted ${WORKER_MAX_RESTARTS} times within ${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing — ` +
          options.giveUpConsequence
        );
        options.onGiveUp?.();
        worker = null;
        return;
      }
      const next: Worker = createWorker();
      worker = next;
      options.onRespawn?.((message: TMessage) => next.postMessage(message));
    };
    return w;
  }

  let worker: Worker | null = createWorker();

  return {
    post: (message: TMessage): void => {
      worker?.postMessage(message);
    },
  };
}
