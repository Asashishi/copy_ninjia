/** 日志参数的线程内严格序列化与凭据脱敏；不负责输出或跨线程传输。 */

import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  botConfigCache,
} from "../../cache/perThread/config";
import { loggerSecretsMemo } from "../../cache/perThread/logger";
import {
  LOGGER_CIRCULAR_ERROR_VALUE,
  LOGGER_MAX_ERROR_NODES,
  LOGGER_MAX_REDACTED_SECRETS,
  LOGGER_MAX_SERIALIZED_BYTES,
  LOGGER_MAX_SERIALIZED_ITEMS,
  LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE,
  LOGGER_NESTED_ERROR_MAX_DEPTH,
  LOGGER_SERIALIZATION_LIMIT_VALUE,
  LOGGER_UNSERIALIZABLE_VALUE,
} from "../../consts/logger";
import { redactSensitiveFieldsInText, safeStringify } from "./redaction";
import { redactSecretsInText } from "../../libs/redaction";
import { jsonSerializedBytes } from "../../libs/jsonBytes";
import type {
  AdDetectAgentConfig,
  AgentCapabilityConfig,
  AgentDeploymentConfig,
  BotConfig,
} from "../../types/config";

/** 一次 emit 内共享的展开预算，调用结束即丢弃，不保存到线程缓存。 */
interface SerializationBudget {
  errors: number;
  items: number;
}

/** 一项能力的凭据：api_key，以及 google provider headers 的每个值。 */
function pushCapabilitySecrets(secrets: string[], config: AgentCapabilityConfig): void {
  secrets.push(config.apiKey);
  if (config.headers === undefined) return;
  for (const value of Object.values(config.headers)) secrets.push(value);
}

/**
 * 本次调用要脱敏的敏感值。每条日志取一次而不是每个参数取一次。Telegram 与
 * agent loader 都把成功结果放在线程内 holder，logger 只读取已有快照，不反向
 * 触发同步文件 I/O。
 *
 * 结果按三个 holder 的对象身份记忆化（holder 见 cache/perThread/logger.ts 的
 * loggerSecretsMemo）。配置身份未变时不重建凭据数组；身份变化（热重载替换快照）
 * 时，上一份名单里不再生效的旧凭据排在当前凭据之后继续脱敏，覆盖旧客户端在途
 * 请求仍可能带出的凭据。总量受 LOGGER_MAX_REDACTED_SECRETS 限制，封顶时丢弃
 * 最早退役的。
 */
function currentSecrets(): readonly string[] {
  const telegram: BotConfig | null = botConfigCache.current;
  const adDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
  const agent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  if (
    loggerSecretsMemo.telegram === telegram &&
    loggerSecretsMemo.adDetect === adDetect &&
    loggerSecretsMemo.agent === agent
  ) return loggerSecretsMemo.value;

  const secrets: string[] = [];
  const telegramToken: string | undefined = telegram?.botToken;
  if (telegramToken !== undefined) secrets.push(telegramToken);
  if (adDetect !== null) pushCapabilitySecrets(secrets, adDetect);
  if (agent !== null) {
    pushCapabilitySecrets(secrets, agent.text);
    pushCapabilitySecrets(secrets, agent.summary);
    pushCapabilitySecrets(secrets, agent.media);
    if (agent.image !== undefined) pushCapabilitySecrets(secrets, agent.image);
    if (agent.tts !== undefined) pushCapabilitySecrets(secrets, agent.tts);
  }
  for (const previous of loggerSecretsMemo.value) {
    if (secrets.length >= LOGGER_MAX_REDACTED_SECRETS) break;
    if (!secrets.includes(previous)) secrets.push(previous);
  }
  loggerSecretsMemo.telegram = telegram;
  loggerSecretsMemo.adDetect = adDetect;
  loggerSecretsMemo.agent = agent;
  loggerSecretsMemo.value = secrets;
  return secrets;
}

/**
 * 把任意日志参数转成可 JSON 序列化的值。Error（含 GrammyError 等子类）
 * 由 serializeError 展开（含嵌套 Error）；其余对象尝试 JSON 序列化，
 * 失败（循环引用等）则退化为字符串。
 *
 * Bun 的 fetch 网络异常会把完整请求 URL 放进 Error 的可枚举 path 字段；
 * Telegram 文件下载 URL 内嵌 BOT_TOKEN。展开后的整棵结构整体序列化成稳定 JSON，
 * 字段名脱敏由 replacer 覆盖每一层，再对整份文本做值级脱敏，确保任一层嵌套 Error
 * 的 message/stack/path/cause 都不会漏。
 */
function serializeArg(arg: unknown, secrets: readonly string[], budget: SerializationBudget): unknown {
  // 字符串参数直接脱敏，不经过 stringify -> 脱敏 -> parse 往返：敏感值本身
  // 含 JSON 转义字符时，往返路径会因转义后不再字面匹配而漏脱敏。
  if (typeof arg === "string") {
    return redactSecretsInText(redactSensitiveFieldsInText(arg), secrets);
  }

  const error: Error | null = asError(arg);
  const serializable: unknown = error !== null
    ? serializeError(error, null, budget)
    : arg;

  const redacted: string = redactSecretsInText(safeStringify(serializable), secrets);
  // 脱敏是对整份 JSON 文本做字面替换；敏感值本身是 JSON 结构字符（如 `"`、`,`）
  // 时，替换结果可能不再是合法 JSON。解析失败就退化为脱敏后的文本，不向上抛出。
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}

/** `instanceof` 也可能触发 Proxy trap；失败时交给普通不可序列化对象路径。 */
function asError(value: unknown): Error | null {
  try {
    return value instanceof Error ? value : null;
  } catch {
    return null;
  }
}

/** Error 的核心字段也允许被子类或 Proxy 改成访问器；读取失败只降级该字段。 */
function readErrorString(
  error: Error,
  key: "name" | "message" | "stack",
  fallback: string | undefined
): string | undefined {
  try {
    const value: unknown = error[key];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

/** `instanceof AggregateError` 同样可能触发 Proxy trap；失败时按普通 Error 处理。 */
function isAggregateError(error: Error): boolean {
  try {
    return error instanceof AggregateError;
  } catch {
    return false;
  }
}

/**
 * 正在展开的 Error 祖先链节点。只在某个 Error 真正含有嵌套 Error 时才为它分配，
 * 顶层 Error 深度为 0；用于深度上限判定与循环引用识别。
 */
interface ErrorExpansionFrame {
  readonly error: Error;
  readonly parent: ErrorExpansionFrame | null;
  readonly depth: number;
}

/**
 * 把一个 Error 展开为 name/message/stack 加 ownErrorProperties 的结果。
 * `parent` 是它的展开链父节点，顶层 Error 传 null。
 */
function serializeError(
  error: Error,
  parent: ErrorExpansionFrame | null,
  budget: SerializationBudget
): Record<string, unknown> | string {
  if (budget.errors === 0) return LOGGER_SERIALIZATION_LIMIT_VALUE;
  budget.errors--;
  return {
    name: readErrorString(error, "name", "Error"),
    message: readErrorString(error, "message", LOGGER_UNSERIALIZABLE_VALUE),
    stack: readErrorString(error, "stack", undefined),
    ...ownErrorProperties(error, parent, budget),
  };
}

/**
 * Error 自有的可枚举属性（GrammyError.payload、Bun fetch 的 code/path 等），外加
 * 不可枚举的 `cause` 与 AggregateError 的 `errors`。只读取数据描述符，不执行 getter。
 * 值为 Error 的字段、`cause` 与 `errors` 数组中的 Error 元素经 serializeNestedError
 * 递归展开；其余值逐个属性独立降级，某个值不可序列化（循环引用、BigInt）时只让它
 * 自己退化成字符串，不连累整条记录。不能用 `{...JSON.parse(safeStringify({...arg}))}`：
 * safeStringify 走 `String(value)` 兜底时返回字符串，展开进对象字面量会变成
 * `{"0":"[","1":"o",...}` 的下标键，覆盖掉 code/path 等真实字段。
 *
 * 累加对象必须用 `Object.create(null)`（无原型）：键名为 `__proto__` 时，向普通
 * `{}` 赋值会命中 Object.prototype 继承的访问器，导致该字段被静默丢弃或整条
 * 记录的原型被替换，字段不会出现在 logs/ 里。
 */
function ownErrorProperties(
  error: Error,
  parent: ErrorExpansionFrame | null,
  budget: SerializationBudget
): Record<string, unknown> {
  const own: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(error);
  } catch {
    return own;
  }
  const aggregate: boolean = isAggregateError(error);
  let frame: ErrorExpansionFrame | null = null;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const aggregateErrors: boolean = aggregate && key === "errors";
    if (!descriptor.enumerable && key !== "cause" && !aggregateErrors) continue;
    if (budget.items === 0) {
      own[key] = LOGGER_SERIALIZATION_LIMIT_VALUE;
      break;
    }
    budget.items--;
    if (!("value" in descriptor)) {
      // 日志不能为了取诊断字段执行依赖对象的 getter；它可能正是原始故障源。
      own[key] = LOGGER_UNSERIALIZABLE_VALUE;
      continue;
    }
    const value: unknown = descriptor.value;
    // JSON 不能表达 undefined；逐个降级时显式跳过，避免凭空生成 null 字段。
    if (value === undefined) continue;
    const nested: Error | null = asError(value);
    if (nested === null && !aggregateErrors) {
      own[key] = JSON.parse(safeStringify(value));
      continue;
    }
    frame ??= {
      error,
      parent,
      depth: parent === null ? 0 : parent.depth + 1,
    };
    own[key] = nested !== null
      ? serializeNestedError(nested, frame, budget)
      : serializeAggregateErrors(value, frame, budget);
  }
  return own;
}

/**
 * 展开 `owner` 的一个嵌套 Error。超过 LOGGER_NESTED_ERROR_MAX_DEPTH，或它已经在
 * 展开链上（循环引用）时返回静态占位符。
 */
function serializeNestedError(nested: Error, owner: ErrorExpansionFrame, budget: SerializationBudget): unknown {
  if (owner.depth >= LOGGER_NESTED_ERROR_MAX_DEPTH) {
    return LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE;
  }
  for (
    let ancestor: ErrorExpansionFrame | null = owner;
    ancestor !== null;
    ancestor = ancestor.parent
  ) {
    if (ancestor.error === nested) return LOGGER_CIRCULAR_ERROR_VALUE;
  }
  return serializeError(nested, owner, budget);
}

/**
 * AggregateError 的 `errors`：数组按下标逐个读取数据描述符，Error 元素递归展开，
 * 其余元素按 JSON 语义降级（空洞与 undefined 为 null，访问器为占位符）；
 * 非数组值按普通字段处理。读取失败只降级这一个字段。
 */
function serializeAggregateErrors(value: unknown, owner: ErrorExpansionFrame, budget: SerializationBudget): unknown {
  try {
    if (!Array.isArray(value)) return JSON.parse(safeStringify(value));
    const length: number = value.length;
    const serialized: unknown[] = [];
    for (let index: number = 0; index < length; index++) {
      if (budget.items === 0) {
        serialized.push(LOGGER_SERIALIZATION_LIMIT_VALUE);
        break;
      }
      budget.items--;
      const descriptor: PropertyDescriptor | undefined =
        Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined) {
        serialized[index] = null;
        continue;
      }
      if (!("value" in descriptor)) {
        serialized[index] = LOGGER_UNSERIALIZABLE_VALUE;
        continue;
      }
      const element: unknown = descriptor.value;
      const nested: Error | null = asError(element);
      serialized[index] = nested !== null
        ? serializeNestedError(nested, owner, budget)
        : JSON.parse(safeStringify(element));
    }
    return serialized;
  } catch {
    return LOGGER_UNSERIALIZABLE_VALUE;
  }
}

/** 单个参数的任何意外失败都只降级该参数，不能替换调用方正在汇报的异常。 */
function serializeArgSafely(
  arg: unknown,
  secrets: readonly string[],
  budget: SerializationBudget
): unknown {
  try {
    return serializeArg(arg, secrets, budget);
  } catch {
    return LOGGER_UNSERIALIZABLE_VALUE;
  }
}

/** 每次 emit 共用配置快照与展开预算，输出只包含已脱敏值及显式截断标记。 */
export function serializeLogArgs(args: readonly unknown[]): unknown[] {
  const secrets: readonly string[] = currentSecrets();
  const budget: SerializationBudget = { errors: LOGGER_MAX_ERROR_NODES, items: LOGGER_MAX_SERIALIZED_ITEMS };
  const serialized: unknown[] = [];
  // 为数组括号、最后一个逗号和截断标记预留空间。
  let remainingBytes: number = LOGGER_MAX_SERIALIZED_BYTES -
    jsonSerializedBytes(LOGGER_SERIALIZATION_LIMIT_VALUE) - 3;
  for (const arg of args) {
    if (budget.items === 0) {
      serialized.push(LOGGER_SERIALIZATION_LIMIT_VALUE);
      break;
    }
    budget.items--;
    const value: unknown = serializeArgSafely(arg, secrets, budget);
    const bytes: number = jsonSerializedBytes(value) + 1;
    if (bytes > remainingBytes) {
      serialized.push(LOGGER_SERIALIZATION_LIMIT_VALUE);
      break;
    }
    serialized.push(value);
    remainingBytes -= bytes;
  }
  return serialized;
}
