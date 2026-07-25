/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 *
 * 本模块可能同时被主线程和其它 Bun Worker（如 aiChatWorker）import。落盘
 * 线程（diskIOWorker）的显式初始化、自愈、flush/load 握手统一由
 * infra/diskIO.ts 管理——入口取得 bot.lock 后才启动该 Worker。此前的 error
 * 只输出到 stderr，不会触碰共享 logs/。该 Worker 同时也是 AI 记忆快照的
 * 落盘线程，只由主线程启动这一个（若每个线程都自建落盘线程，多个实例按
 * 字节偏移并发追加同一个日志文件会互相踩踏写坏文件）。这里只是门面：主线程
 * 下 error 日志经 relayLogMessage 转投给它；Worker 线程里的 logger 处于「转发模式」：
 * error 日志包上 ForwardedLog 信封 postMessage 回主线程，由拥有该 Worker
 * 的主线程模块（见 aiChat/index.ts 的 onEvent）调用 relayLogMessage 转投唯一的
 * 落盘线程。
 */

import { relayLogMessage } from "./diskIO";
import type { ForwardedLog, LogLevel, LogMessage } from "../types/diskIO";
import { redactSecretsInText } from "../libs/redaction";

declare const self: Worker;

// 是否运行在主线程：决定 error 日志是直接转投落盘线程，还是包上信封向上
// 转发给拥有本 Worker 的主线程模块。
const isMainThread: boolean = Bun.isMainThread;

/**
 * 本次调用要脱敏的敏感值。每条日志取一次而不是每个参数取一次；不提到模块
 * 加载期，是为了不依赖「logger 首次 import 时 env 已就绪」这个额外前提
 * （logger 必须在 infra/config.ts 的 env 校验失败时也能照常记录）。
 */
function currentSecrets(): string[] {
  return [
    process.env.TELEGRAM_BOT_TOKEN ?? "",
    process.env.GEMINI_API_KEY ?? "",
  ];
}

/**
 * 把任意日志参数转成可 JSON 序列化的值。Error（含 GrammyError 等子类）
 * 展开为 name/message/stack 加自有可枚举属性；其余对象尝试 JSON 序列化，
 * 失败（循环引用等）则退化为字符串。
 *
 * Bun 的 fetch 网络异常会把完整请求 URL 放进 Error 的可枚举 path 字段；
 * Telegram 文件下载 URL 内嵌 BOT_TOKEN。对象先序列化成稳定 JSON，再对整份
 * 文本做值级脱敏，确保 message/stack/path/cause 任一位置都不会漏。
 */
function serializeArg(arg: unknown, secrets: readonly string[]): unknown {
  // 绝大多数日志参数是拼好的字符串（本项目的 logger.log/info/warn 全部如此）。
  // 字符串直接脱敏即可，不必走 stringify -> 脱敏 -> parse 的往返：两条路径对
  // 字符串的结果逐字符相同，唯一的差异是敏感值自身含 JSON 转义字符时，往返
  // 路径反而会因为转义后不再字面匹配而漏脱敏，直接脱敏没有这个问题。
  if (typeof arg === "string") return redactSecretsInText(arg, secrets);

  let serializable: unknown;
  if (arg instanceof Error) {
    serializable = {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
      ...JSON.parse(safeStringify({ ...arg })),
    };
  } else if (arg === null || typeof arg !== "object") {
    serializable = arg;
  } else {
    serializable = JSON.parse(safeStringify(arg));
  }

  return JSON.parse(redactSecretsInText(safeStringify(serializable), secrets));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

function emit(level: LogLevel, args: unknown[]): void {
  // 显式箭头包一层：map 会把 index 当第二个实参传进去，不能直接传 serializeArg。
  const secrets: readonly string[] = currentSecrets();
  const serializedArgs: unknown[] = args.map((arg: unknown): unknown => serializeArg(arg, secrets));
  // 所有控制台级别都可能被 journal 长期保存，统一输出脱敏后的参数；不能
  // 只保护 error 的 JSON 文件而让 info/warn 中未来新增的敏感值原样泄露。
  console[level](...serializedArgs);
  if (level !== "error") return;
  const message: LogMessage = {
    timestamp: Date.now(),
    level,
    args: serializedArgs,
  };
  if (isMainThread) {
    relayLogMessage(message);
  } else {
    // 转发模式（本模块运行在某个 Worker 线程里）：发回主线程转投落盘线程。
    self.postMessage({ __log: message } satisfies ForwardedLog);
  }
}

/** 主线程与 Worker 共用的日志出口；Worker 侧经 postMessage 转发到主线程。 */
interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export const logger: Logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
