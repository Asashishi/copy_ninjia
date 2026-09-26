import { isPlainRecord } from "./record";
import { isTelegramGroupChatId } from "./telegramId";
import {
  invalidInput,
  optionalBooleanField,
  optionalStringField,
  optionalTimestampField,
} from "./inputValidation";
import type { InputFieldContext } from "./inputValidation";
import type { TtsDailyUsage } from "../types/aiChat/voiceMessage";
import type {
  CachedUser,
  CopyMode,
  DecodedGlobalCopyState,
  DecodedGlobalState,
} from "../types/chatState";

/**
 * memory/global/state.json 当前 schema 的纯解码器。本模块不执行 I/O；所有持久化字段都从
 * unknown 逐项收窄，未知字段、类型错误和跨字段不变量冲突经 invalidInput 拒绝整个
 * 文件，报错只含文件路径、字段路径与期望形态。
 */

/** 子字段的解码上下文。 */
function at(context: InputFieldContext, key: string): InputFieldContext {
  return { source: context.source, path: `${context.path}.${key}` };
}

function record(value: unknown, context: InputFieldContext): Record<string, unknown> {
  if (!isPlainRecord(value)) return invalidInput(context.source, context.path, "an object");
  return value;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], context: InputFieldContext): void {
  const keys: Set<string> = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      invalidInput(context.source, `${context.path}.${key}`, "absent (not part of the current state schema)");
    }
  }
}

function requiredKey(value: Record<string, unknown>, key: string, context: InputFieldContext): void {
  if (!(key in value)) invalidInput(context.source, `${context.path}.${key}`, "present");
}

function copyMode(value: unknown, context: InputFieldContext): CopyMode | undefined {
  if (value === undefined) return undefined;
  if (value === "reverse" || value === "nya") return value;
  return invalidInput(context.source, context.path, "one of reverse or nya");
}

function cachedUser(value: unknown, context: InputFieldContext): CachedUser {
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["id", "username", "first_name", "last_name", "title", "isChannel"], context);
  if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id === 0) {
    return invalidInput(context.source, `${context.path}.id`, "a non-zero safe integer");
  }
  return {
    id: raw.id,
    username: optionalStringField(raw, "username", context),
    first_name: optionalStringField(raw, "first_name", context),
    last_name: optionalStringField(raw, "last_name", context),
    title: optionalStringField(raw, "title", context),
    isChannel: optionalBooleanField(raw, "isChannel", context),
  };
}

function globalCopy(value: unknown, context: InputFieldContext): DecodedGlobalCopyState {
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["lastCopyTime", "copiedUser", "copyMode", "copyChatId"], context);
  requiredKey(raw, "copiedUser", context);
  const lastCopyTime: number | undefined = optionalTimestampField(raw, "lastCopyTime", context);
  if (raw.copiedUser === null) {
    if (raw.copyMode !== undefined || raw.copyChatId !== undefined) {
      return invalidInput(context.source, context.path, "free of copyMode and copyChatId when copiedUser is null");
    }
    return { copiedUser: null, lastCopyTime };
  }
  if (!isTelegramGroupChatId(raw.copyChatId)) {
    return invalidInput(
      context.source,
      `${context.path}.copyChatId`,
      "a negative safe integer Telegram group or channel ID when copiedUser is set"
    );
  }
  return {
    lastCopyTime,
    copiedUser: cachedUser(raw.copiedUser, at(context, "copiedUser")),
    copyMode: copyMode(raw.copyMode, at(context, "copyMode")),
    copyChatId: raw.copyChatId,
  };
}

/**
 * 语音合成每日计数。整块缺省表示从没用过；存在时两个字段都必填：windowStartedAt
 * 是非负安全整数时间戳，count 是正安全整数。count 不与 `agent.tts.daily_limit` 对拍：上限调低后
 * 窗口内已用次数可能超过新上限，按额度用尽处理。
 */
function globalTtsUsage(value: unknown, context: InputFieldContext): TtsDailyUsage | undefined {
  if (value === undefined) return undefined;
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["windowStartedAt", "count"], context);
  const windowStartedAt: unknown = raw.windowStartedAt;
  if (typeof windowStartedAt !== "number" || !Number.isSafeInteger(windowStartedAt) || windowStartedAt < 0) {
    return invalidInput(context.source, `${context.path}.windowStartedAt`, "a non-negative safe integer timestamp");
  }
  const count: unknown = raw.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    return invalidInput(context.source, `${context.path}.count`, "a positive safe integer");
  }
  return { windowStartedAt, count };
}

/**
 * 解码完整的全局状态文件；顶层只接受 copy（必填）与 ttsUsage（可缺省），任何存在但
 * 非法的字段都会拒绝整个文件（见 types/chatState.ts 的 GlobalState）。
 * @param source 出现在报错里的文件路径。
 */
export function decodeGlobalStateFile(value: unknown, source: string): DecodedGlobalState {
  const context: InputFieldContext = { source, path: "$" };
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["copy", "ttsUsage"], context);
  requiredKey(raw, "copy", context);
  return {
    copy: globalCopy(raw.copy, at(context, "copy")),
    ttsUsage: globalTtsUsage(raw.ttsUsage, at(context, "ttsUsage")),
  };
}
