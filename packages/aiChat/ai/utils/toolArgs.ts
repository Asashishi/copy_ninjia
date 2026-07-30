/**
 * 从工具调用的参数 JSON 字符串里解析单个字段的纯函数族：JSON.parse 失败/
 * 字段缺失/类型不对一律返回 null（或对布尔字段返回 false），不抛错——
 * 调用方按各自的错误提示喂回模型。aiChat/ai/tools/replyToolset/ 与
 * aiChat/ai/tools/stickers.ts 共用，避免各自重复一份 try/catch JSON.parse 样板。
 */

/** 解析出一个非空字符串字段；解析失败/缺失/类型不对返回 null。 */
export function parseStringField(argumentsJson: string, field: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const value: unknown = (parsed as Record<string, unknown> | null)?.[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/** 解析出一个布尔字段；解析失败/缺失/类型不对一律按 false 处理（供可选、
 *  缺省即「否」的参数使用，如 send_message 的 reply_to_trigger）。 */
export function parseBooleanField(argumentsJson: string, field: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return false;
  }
  return (parsed as Record<string, unknown> | null)?.[field] === true;
}

/**
 * 解析出一个合法的 1-based 编号字段（正整数且落在 [1, max] 内）；JSON 解析
 * 失败、字段缺失/类型不对/不是整数，或超出范围，一律返回 null。
 */
export function parseIndexField(argumentsJson: string, field: string, max: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const index: unknown = (parsed as Record<string, unknown> | null)?.[field];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > max) return null;
  return index;
}
