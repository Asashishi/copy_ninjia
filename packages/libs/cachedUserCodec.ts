import { CACHED_USER_KEYS } from "../consts/storageSchema";
import { hasOnlyKeys, isPlainRecord } from "./record";
import {
  invalidInput,
  optionalBooleanField,
  optionalStringField,
} from "./inputValidation";
import type { InputFieldContext } from "./inputValidation";
import type { CachedUser } from "../types/chatState";

/**
 * 持久化目标身份（state.json 的复读目标、群状态的翻译目标）的严格解码：只接受 CACHED_USER_KEYS
 * 列出的键，id 为非零安全整数，可选字符串字段按 Telegram 给出的原样保留（名称与群名可以是空字符串）；
 * 按固定字段顺序构造。
 */
export function decodeCachedUser(value: unknown, context: InputFieldContext): CachedUser {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CACHED_USER_KEYS)) {
    return invalidInput(context.source, context.path, "an object containing only id, username, first_name, last_name, title and isChannel");
  }
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id === 0) {
    return invalidInput(context.source, `${context.path}.id`, "a non-zero safe integer");
  }
  return {
    id: value.id,
    username: optionalStringField(value, "username", context),
    first_name: optionalStringField(value, "first_name", context),
    last_name: optionalStringField(value, "last_name", context),
    title: optionalStringField(value, "title", context),
    isChannel: optionalBooleanField(value, "isChannel", context),
  };
}
