/** 验证状态机 Map 的键：同一个人在不同群里独立追踪，见 cache/antiRaidWorker.ts
 *  的 verificationEntries / recentChannelComments。多处共用的叶子函数。 */
export function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}
