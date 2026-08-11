/**
 * 累加非负安全整数并在 Number.MAX_SAFE_INTEGER 饱和，避免长期计数失真回绕。
 */
export function saturatingSafeIntegerAdd(left: number, right: number): number {
  if (right >= Number.MAX_SAFE_INTEGER - left) return Number.MAX_SAFE_INTEGER;
  return left + right;
}
