/**
 * 第 attempt 次重试（0 起算）的指数退避时长：baseMs × 2^attempt，封顶 maxMs。
 * 次数很大时乘积溢出为 Infinity，同样落在封顶值上。
 */
export function cappedExponentialMs(baseMs: number, attempt: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}
