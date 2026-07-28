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
 * 需要脱敏的环境变量名。每新增一个密钥类 env（见 infra/config.ts）都必须
 * 同步登记到这里，否则携带该值的错误对象会原样落进 logs/ 和 journal。
 * 这里只写变量名而不 import infra/config.ts：那个模块在 env 缺失时会在
 * 求值期抛错，而 logger 必须在校验失败时也能照常记录。
 */
const SECRET_ENV_NAMES: readonly string[] = [
  "TELEGRAM_BOT_TOKEN",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
];

/**
 * 本次调用要脱敏的敏感值。每条日志取一次而不是每个参数取一次；不提到模块
 * 加载期，是为了不依赖「logger 首次 import 时 env 已就绪」这个额外前提
 * （logger 必须在 infra/config.ts 的 env 校验失败时也能照常记录）。
 */
function currentSecrets(): string[] {
  // config.ts 的 requireEnv() 返回 trim 后的值，请求实际使用的也是那一份。
  // 这里若保留 env 原文，systemd/CRLF 带来的尾随空白会让脱敏目标与 URL 里的
  // token 不同，恰好把真正发出去的凭据漏进 journal 与 logs/。
  return SECRET_ENV_NAMES.map((name: string): string => process.env[name]?.trim() ?? "");
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

  const serializable: unknown = arg instanceof Error
    ? { name: arg.name, message: arg.message, stack: arg.stack, ...ownEnumerableProperties(arg) }
    // 非 Error 不预先做一轮 stringify/parse：下面那一轮的结果与先往返一次
    // 完全相同（safeStringify 的兜底对两条路径同样降级），白付一次全量序列化。
    : arg;

  return JSON.parse(redactSecretsInText(safeStringify(serializable), secrets));
}

/**
 * Error 自有的可枚举属性（GrammyError.payload、Bun fetch 的 code/path 等），
 * 逐个属性独立降级：某个值不可序列化（循环引用、BigInt）时只让它自己退化成
 * 字符串，不会连累整条记录。不能整体 `{...JSON.parse(safeStringify({...arg}))}`
 * ——safeStringify 走 `String(value)` 兜底时返回的是字符串，展开进对象字面量
 * 会炸成 `{"0":"[","1":"o",...}` 一串下标键，把真正要看的 code/path 冲掉。
 */
function ownEnumerableProperties(error: Error): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...error })) {
    // 值为 undefined 的键整体丢掉，与「先整份 stringify 再 parse」的旧行为一致
    // ——JSON 本来就表达不了 undefined，逐个降级时若不显式跳过，会把它变成一个
    // 凭空多出来的 null 字段。
    if (value === undefined) continue;
    own[key] = JSON.parse(safeStringify(value));
  }
  return own;
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
