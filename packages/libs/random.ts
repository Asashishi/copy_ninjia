/** 从数组中均匀随机挑一项；数组为空时返回 undefined。 */
export function pickRandom<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}
