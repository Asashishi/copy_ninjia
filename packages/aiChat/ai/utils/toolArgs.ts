/**
 * 从工具调用的参数 JSON 字符串里解析字段的纯函数族：JSON.parse 失败/字段缺失/
 * 类型不对一律返回 null（或对布尔字段返回 false），不抛错——调用方按各自的错误
 * 提示喂回模型。aiChat/ai/tools/replyToolset/ 与 aiChat/ai/tools/stickers.ts 共用，
 * 避免各自重复一份 try/catch JSON.parse 样板。
 *
 * 需要一次读多个字段的工具（生图、生歌）直接用 parseToolArguments 拿整张记录，
 * 不要为每个字段各解析一遍。
 */

import { isPlainRecord } from "../../../libs/record";

/**
 * 把参数 JSON 解析成一张普通记录；解析失败或顶层不是对象时返回 null。
 *
 * 本模块的每个字段解析器都从这里起步，多字段的工具也用它——那份 try/catch
 * 样板因此只有一处。顶层用 `isPlainRecord` 判而不是 cast：数组、数字、`null`
 * 同样解析得出来，它们只是一个字段也取不到，提前收窄比在取值处兜底更直白。
 */
export function parseToolArguments(argumentsJson: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  return isPlainRecord(parsed) ? parsed : null;
}

/** 解析出一个非空字符串字段；解析失败/缺失/类型不对返回 null。 */
export function parseStringField(argumentsJson: string, field: string): string | null {
  const value: unknown = parseToolArguments(argumentsJson)?.[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/** 解析出一个布尔字段；解析失败/缺失/类型不对一律按 false 处理（供可选、
 *  缺省即「否」的参数使用，如 send_message 的 reply_to_trigger）。 */
export function parseBooleanField(argumentsJson: string, field: string): boolean {
  return parseToolArguments(argumentsJson)?.[field] === true;
}

/**
 * 解析出一个合法的 1-based 编号字段（正整数且落在 [1, max] 内）；JSON 解析
 * 失败、字段缺失/类型不对/不是整数，或超出范围，一律返回 null。
 */
export function parseIndexField(argumentsJson: string, field: string, max: number): number | null {
  const index: unknown = parseToolArguments(argumentsJson)?.[field];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > max) return null;
  return index;
}
