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
import { createLogRedactionReplacer, redactSensitiveFieldsInText, safeStringify } from "./redaction";
import { redactSecretsInText } from "../../libs/redaction";
import { jsonSerializedBytes } from "../../libs/jsonBytes";
import type {
  AdDetectAgentConfig,
  AgentCapabilityConfig,
  AgentDeploymentConfig,
  AgentTtsCapabilityConfig,
  BotConfig,
} from "../../types/config";
import type { LogRedactionSecrets, LoggerSecretsSnapshot } from "../../types/logger";

/** 一次 emit 内共享的展开预算，调用结束即丢弃，不保存到线程缓存。 */
interface SerializationBudget {
  errors: number;
  items: number;
  readonly secrets: LogRedactionSecrets;
}

/** 一项能力的凭据：api_key，以及 google provider headers 的每个值。 */
function pushCapabilitySecrets(secrets: string[], config: AgentCapabilityConfig | AgentTtsCapabilityConfig): void {
  secrets.push(config.apiKey);
  if (config.headers === undefined) return;
  for (const value of Object.values(config.headers)) secrets.push(value);
}

/**
 * 本次调用要脱敏的敏感值，每条日志取一次。Telegram 与 agent loader 把成功结果
 * 放在线程内 holder，logger 只读取已有快照，不触发同步文件 I/O。
 *
 * 文本凭据、JSON 转义片段与遍历回调按三个 holder 的对象身份记忆化（三个 holder 见
 * cache/perThread/config.ts，记忆见 cache/perThread/logger.ts 的 loggerSecretsMemo）。
 * 配置身份未变时复用只读快照；身份变化（热重载替换快照）
 * 时，上一份名单里不再生效的旧凭据排在当前凭据之后继续脱敏。总量受
 * LOGGER_MAX_REDACTED_SECRETS 限制，封顶时丢弃最早退役的。
 */
function currentSecrets(): LogRedactionSecrets {
  const telegram: BotConfig | null = botConfigCache.current;
  const adDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
  const agent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  const previous: LoggerSecretsSnapshot | null = loggerSecretsMemo.current;
  if (
    previous !== null && previous.telegram === telegram &&
    previous.adDetect === adDetect && previous.agent === agent
  ) return previous;

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
    if (agent.webSearch !== undefined) pushCapabilitySecrets(secrets, agent.webSearch);
  }
  if (previous !== null) {
    for (const secret of previous.text) {
      if (secrets.length >= LOGGER_MAX_REDACTED_SECRETS) break;
      if (!secrets.includes(secret)) secrets.push(secret);
    }
  }
  const jsonSecrets: string[] = [];
  for (const secret of secrets) jsonSecrets.push(JSON.stringify(secret).slice(1, -1));
  const snapshot: LoggerSecretsSnapshot = {
    text: secrets, json: jsonSecrets, replacer: createLogRedactionReplacer(secrets), telegram, adDetect, agent,
  };
  loggerSecretsMemo.current = snapshot;
  return snapshot;
}

/**
 * 把任意日志参数转成可 JSON 序列化的值。Error（含 GrammyError 等子类）
 * 由 serializeError 展开（含嵌套 Error）；其余对象尝试 JSON 序列化，
 * 失败（循环引用等）则退化为字符串。
 *
 * 展开后的整棵结构整体序列化成 JSON，字段名、原文凭据及 URL 脱敏由快照回调覆盖
 * 每一层，再用 JSON 转义后的凭据片段匹配整份 JSON，覆盖对象键中的已登记凭据。
 */
function serializeArg(arg: unknown, budget: SerializationBudget): unknown {
  const secrets: LogRedactionSecrets = budget.secrets;
  if (typeof arg === "string") {
    return redactSensitiveFieldsInText(redactSecretsInText(arg, secrets.text));
  }

  const error: Error | null = asError(arg);
  const serializable: unknown = error !== null
    ? serializeError(error, null, budget)
    : arg;

  const redacted: string = redactSecretsInText(safeStringify(serializable, secrets.replacer), secrets.json);
  // 脱敏是对整份 JSON 文本做字面替换，结果可能不是合法 JSON；解析失败时返回脱敏后的文本。
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
 * 自己退化成字符串，不连累整条记录；降级结果作为该属性的值保存，不展开进对象。
 *
 * 累加对象用 `Object.create(null)`（无原型），键名 `__proto__` 作为普通字段保留。
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
      // 不执行访问器 getter。
      own[key] = LOGGER_UNSERIALIZABLE_VALUE;
      continue;
    }
    const value: unknown = descriptor.value;
    // JSON 不能表达 undefined，显式跳过。
    if (value === undefined) continue;
    const nested: Error | null = asError(value);
    if (nested === null && !aggregateErrors) {
      own[key] = JSON.parse(safeStringify(value, budget.secrets.replacer));
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
    if (!Array.isArray(value)) return JSON.parse(safeStringify(value, budget.secrets.replacer));
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
        : JSON.parse(safeStringify(element, budget.secrets.replacer));
    }
    return serialized;
  } catch {
    return LOGGER_UNSERIALIZABLE_VALUE;
  }
}

/** 单个参数的任何意外失败只降级该参数。 */
function serializeArgSafely(
  arg: unknown,
  budget: SerializationBudget
): unknown {
  try {
    return serializeArg(arg, budget);
  } catch {
    return LOGGER_UNSERIALIZABLE_VALUE;
  }
}

/** 每次 emit 共用配置快照与展开预算，输出只包含已脱敏值及显式截断标记。 */
export function serializeLogArgs(args: readonly unknown[]): unknown[] {
  const secrets: LogRedactionSecrets = currentSecrets();
  const budget: SerializationBudget = { errors: LOGGER_MAX_ERROR_NODES, items: LOGGER_MAX_SERIALIZED_ITEMS, secrets };
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
    const value: unknown = serializeArgSafely(arg, budget);
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
