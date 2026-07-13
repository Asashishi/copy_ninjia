/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 *
 * 本模块可能同时被主线程和其它 Bun Worker（如 aiChatWorker）import。
 * 落盘线程（loggerWorker）只由主线程启动这一个——若每个线程都自建落盘
 * 线程，多个实例按字节偏移并发追加同一个日志文件会互相踩踏写坏文件。
 * Worker 线程里的 logger 因此处于「转发模式」：error 日志包上 ForwardedLog
 * 信封 postMessage 回主线程，由拥有该 Worker 的主线程模块（见 aiChat.ts
 * 的 onmessage）调用 relayLogMessage 转投唯一的落盘线程。
 */

import { pendingFlushes } from "../cache/logger";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../consts/workerSupervisor";
import { createRestartThrottle } from "../libs/workerSupervisor";
import type { FlushReply, FlushRequest, ForwardedLog, LogLevel, LogMessage } from "../types";

declare var self: Worker;

// 是否运行在主线程：诊断 diskWorker 为 null 到底是「没启动过（转发模式）」
// 还是「启动过但自愈耗尽放弃了」，两种情况 emit() 里的兜底行为不一样。
const isMainThread: boolean = Bun.isMainThread;

// 落盘 Worker 崩溃自愈的节流，避免陷入无限重启烧 CPU；耗尽后只保留控制台
// 输出。参数与阈值定义见 consts/workerSupervisor.ts。
const restartThrottle = createRestartThrottle(WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS);

// 落盘 Worker 只在主线程启动；Worker 线程里始终为 null，走转发模式（见
// emit）。unref 让它不阻止进程退出：bot 主循环结束后进程照常退出，不会
// 被空闲的日志线程挂住。
let diskWorker: Worker | null = isMainThread ? createDiskWorker() : null;

function createDiskWorker(): Worker {
  const w: Worker = new Worker(new URL("../workers/loggerWorker.ts", import.meta.url).href);
  w.unref();
  w.onmessage = (event: MessageEvent<FlushReply>) => {
    const resolve = pendingFlushes.get(event.data.flushedId);
    if (resolve) {
      pendingFlushes.delete(event.data.flushedId);
      resolve();
    }
  };
  w.onerror = (event: ErrorEvent) => {
    // 落盘线程自己出错时不能再指望它把这条日志落盘，直接走控制台，
    // 避免自己给自己转发出一场递归。Bun 里 Worker 内部一旦抛出未捕获异常
    // （同步或 async 均如此，已实测验证）就会直接终止该 Worker 线程，这里
    // 不需要（实际上也没法）再手动 terminate，直接换一个新实例顶上即可；
    // diskWorker 换成 null 的分支同理会被下面 emit() 里的判空接住，不会
    // 对着一个已终止的 Worker 继续 postMessage。
    console.error("[logger] persistence Worker errored:", event.message || event.error || event);
    if (restartThrottle.shouldGiveUp()) {
      console.error(
        `[logger] persistence Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
        `${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing — logs will only stay in the console until the process restarts.`
      );
      diskWorker = null;
      return;
    }
    diskWorker = createDiskWorker();
  };
  return w;
}

// flushLogs 的回执 id 分配（路由表见 cache/logger.ts 的 pendingFlushes）。
// postMessage 按 FIFO 送达，flush 指令一定在它之前的日志消息都入队后才被
// 处理，回执即代表已落盘。
let nextFlushId: number = 1;

/**
 * 把其它 Worker 线程转发来的 error 日志转投落盘线程。仅主线程调用——
 * 由拥有对应 Worker 的模块在 onmessage 里识别 ForwardedLog 信封后调用。
 */
export function relayLogMessage(message: LogMessage): void {
  diskWorker?.postMessage(message);
}

/**
 * 要求日志线程立即把内存 buffer 落盘，并等待完成。用于进程退出前的
 * 最后一刷，保证停留在 buffer 里（最长一分钟）的日志不随进程丢失。
 * 带超时兜底：worker 异常时停机流程最多被拖住 timeoutMs，不会挂死。
 * Worker 线程里没有本地落盘 buffer（日志都已转发出去），直接完成。
 */
export function flushLogs(timeoutMs: number = 3000): Promise<void> {
  const worker: Worker | null = diskWorker;
  if (!worker) return Promise.resolve();
  return new Promise((resolve) => {
    const id: number = nextFlushId++;
    const timer = setTimeout(() => {
      pendingFlushes.delete(id);
      resolve();
    }, timeoutMs);
    pendingFlushes.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
    const request: FlushRequest = { flushId: id };
    worker.postMessage(request);
  });
}

/**
 * 把任意日志参数转成可 JSON 序列化的值。Error（含 GrammyError 等子类）
 * 展开为 name/message/stack 加自有可枚举属性；其余对象尝试 JSON 序列化，
 * 失败（循环引用等）则退化为字符串。
 */
function serializeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
      ...JSON.parse(safeStringify({ ...arg })),
    };
  }
  if (arg === null || typeof arg !== "object") {
    return arg;
  }
  return JSON.parse(safeStringify(arg));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

function emit(level: LogLevel, args: unknown[]): void {
  console[level](...args);
  if (level === "error") {
    const message: LogMessage = {
      timestamp: Date.now(),
      level,
      args: args.map(serializeArg),
    };
    if (diskWorker) {
      diskWorker.postMessage(message);
    } else if (!isMainThread) {
      // 转发模式（本模块运行在某个 Worker 线程里）：发回主线程转投落盘线程。
      self.postMessage({ __log: message } satisfies ForwardedLog);
    }
    // 主线程但 diskWorker 为 null：自愈已放弃，前面的 console[level] 已经
    // 输出过，这里无需（也不能）再往哪儿转发。
  }
}

export const logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
