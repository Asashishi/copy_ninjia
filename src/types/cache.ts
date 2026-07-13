/** 「最近一次成功结果 + 时刻」形态的内存缓存，供各领域的 cache/*.ts 复用。 */
export interface TimedCache<T> {
  result: T | null;
  at: number;
}
