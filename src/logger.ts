/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 */

export type LogLevel = "log" | "info" | "warn" | "error";

/** 发给 worker 的消息结构：毫秒时间戳 + 级别 + 已序列化的参数列表。 */
export interface LogMessage {
  timestamp: number;
  level: LogLevel;
  args: unknown[];
}

// Worker 在模块加载时启动一次。unref 让它不阻止进程退出：bot 主循环
// 结束后进程照常退出，不会被空闲的日志线程挂住。
const worker: Worker = new Worker(new URL("./loggerWorker.ts", import.meta.url).href);
worker.unref();

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
    worker.postMessage(message);
  }
}

export const logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
