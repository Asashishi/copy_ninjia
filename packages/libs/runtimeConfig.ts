/** JSON 部署配置的最小结构校验工具；所有输入均按不可信数据处理。 */

/** 判断未知值是否为只包含非空字符串的数组，并为后续使用保留元素类型。 */
export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown): boolean => typeof item === "string" && item.trim().length > 0);
}
