/** 运行时配置的最小结构校验工具。配置文件和环境变量均属于不可信输入。 */

/** 判断未知值是否为可逐字段校验的普通对象。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 要求对象键集合与 schema 完全一致，额外字段也视为配置错误。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys: string[] = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key: string) => Object.hasOwn(value, key));
}

/** 判断未知值是否为只包含非空字符串的数组，并为后续使用保留元素类型。 */
export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string" && item.trim().length > 0);
}

/** Telegram 用户 ID 必须是十进制正安全整数，拒绝指数、小数和隐式空白。 */
export function parseTelegramUserId(raw: string, source: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid Telegram user ID in ${source}: "${raw}" (expected a positive decimal integer)`);
  }
  const id: number = Number(raw);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`Invalid Telegram user ID in ${source}: "${raw}" (outside the safe integer range)`);
  }
  return id;
}

/** 解析逗号分隔的 Telegram 用户 ID；允许整项为空，并对重复 ID 去重。 */
export function parseTelegramUserIdList(raw: string, source: string): readonly number[] {
  if (raw.trim() === "") return Object.freeze([]);
  return Object.freeze([...new Set(raw.split(",").map((part: string) => parseTelegramUserId(part.trim(), source)))]);
}
