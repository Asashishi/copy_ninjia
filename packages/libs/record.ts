/**
 * 判断未知值是否为可逐字段校验的非数组对象。
 *
 * 本守卫只负责 JSON/SDK 输入的第一层结构收窄；字段集合与字段类型仍由各领域
 * codec 严格校验，不在通用层猜测或修复。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 要求对象键集合与调用方 schema 完全一致。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys: string[] = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key: string): boolean => Object.hasOwn(value, key));
}

/** 要求对象不包含调用方 schema 之外的键，但允许可选键缺省。 */
export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed: ReadonlySet<string> = new Set(keys);
  return Object.keys(value).every((key: string): boolean => allowed.has(key));
}
