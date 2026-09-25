import { isAbsolute } from "node:path";
import { isPlainRecord } from "./record";
import { isTelegramGroupChatId } from "./telegramId";
import {
  invalidInput,
  optionalBooleanField,
  optionalStringField,
  optionalTimestampField,
} from "./inputValidation";
import type { InputFieldContext } from "./inputValidation";
import type {
  CachedUser,
  CopyMode,
  GlobalAssetState,
  DecodedGlobalCopyState,
  DecodedGlobalState,
  DecodedStateFile,
} from "../types/chatState";

/**
 * state.json 当前 schema 的纯解码器。本模块不执行 I/O；所有持久化字段都从
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

/**
 * 外部素材直链：缺省即从没设过，由代码常量兜底；存在时去掉首尾空白后必须能解析为
 * 绝对 URL，协议为 https（`allowHttp` 为 true 时也接受 http，只用于机器人默认头像）。
 * 返回 URL 构造器归一化后的 href。
 */
function assetUrl(value: unknown, context: InputFieldContext, allowHttp: boolean = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalidInput(context.source, context.path, "a non-empty string");
  const raw: string = value.trim();
  if (raw.length === 0) return invalidInput(context.source, context.path, "a non-empty string");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidInput(context.source, context.path, `an absolute ${allowHttp ? "http(s)" : "https"} URL`);
  }
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    return invalidInput(context.source, context.path, `an ${allowHttp ? "http or https" : "https"} URL`);
  }
  return parsed.href;
}

/**
 * 素材目录路径：非空、不含 NUL，且只收绝对路径或以 `./`、`../` 开头的显式相对路径。
 * 裸目录名和 `~` 开头的写法一律拒绝整份文件——后者会被当成名叫 `~` 的目录建出来。
 * 收下去掉首尾空白后的值，解析在 stateStore 的取值函数里做。
 */
function assetDirectory(value: unknown, context: InputFieldContext): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalidInput(context.source, context.path, "a non-empty path string");
  const raw: string = value.trim();
  if (raw.length === 0 || raw.includes("\0")) {
    return invalidInput(context.source, context.path, "a non-empty path string without NUL");
  }
  if (!isAbsolute(raw) && !raw.startsWith("./") && !raw.startsWith("../")) {
    return invalidInput(context.source, context.path, "an absolute path or a relative path starting with ./ or ../");
  }
  return raw;
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
 * 随机图片目录与全局素材直链。整块缺省按「五项都没设过」处理；块内字段存在但
 * 非法照旧拒绝整份文件。两条分支返回同一组字段。
 */
function globalAssets(value: unknown, context: InputFieldContext): GlobalAssetState {
  if (value === undefined) {
    return {
      randomHImageDir: undefined,
      fortuneThumbnailUrl: undefined,
      probabilityThumbnailUrl: undefined,
      gagThumbnailUrl: undefined,
      botDefaultAvatarUrl: undefined,
    };
  }
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, [
    "randomHImageDir",
    "fortuneThumbnailUrl",
    "probabilityThumbnailUrl",
    "gagThumbnailUrl",
    "botDefaultAvatarUrl",
  ], context);
  return {
    randomHImageDir: assetDirectory(raw.randomHImageDir, at(context, "randomHImageDir")),
    fortuneThumbnailUrl: assetUrl(raw.fortuneThumbnailUrl, at(context, "fortuneThumbnailUrl")),
    probabilityThumbnailUrl: assetUrl(raw.probabilityThumbnailUrl, at(context, "probabilityThumbnailUrl")),
    gagThumbnailUrl: assetUrl(raw.gagThumbnailUrl, at(context, "gagThumbnailUrl")),
    botDefaultAvatarUrl: assetUrl(raw.botDefaultAvatarUrl, at(context, "botDefaultAvatarUrl"), true),
  };
}

/** 所有群共用的那一块；copy 必填，assets 可缺省。 */
function globalState(value: unknown, context: InputFieldContext): DecodedGlobalState {
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["copy", "assets"], context);
  requiredKey(raw, "copy", context);
  return {
    copy: globalCopy(raw.copy, at(context, "copy")),
    assets: globalAssets(raw.assets, at(context, "assets")),
  };
}

/**
 * 解码完整 state.json；任何存在但非法的字段都会拒绝整个文件，顶层只接受
 * global（见 types/chatState.ts 的 StateFileSchema）。
 * @param source 出现在报错里的文件路径。
 */
export function decodeStateFile(value: unknown, source: string): DecodedStateFile {
  const context: InputFieldContext = { source, path: "state" };
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["global"], context);
  requiredKey(raw, "global", context);
  return { global: globalState(raw.global, at(context, "global")) };
}
