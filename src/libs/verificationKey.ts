/** 跨主线程、Anti-Raid Worker 与 Disk I/O Worker 共用的待验证序列化键。 */
export function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}
