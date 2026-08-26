/**
 * 跨主线程、Anti-Raid Worker 与 Disk I/O Worker 共用的待验证序列化键
 * （`chatId:userId`）。广告检测队列复用同一格式（见
 * workers/antiRaid/adDetect/queue.ts）。
 *
 * 生成、解析和归属判定都收在本文件；任何格式变更必须同时维护这里的往返校验，
 * 避免调用点静默丢弃或错投验证条目。
 */

/** chatId 与 userId 之间的分隔符；生成与解析共用同一个事实源。 */
const KEY_SEPARATOR: string = ":";

export function verificationKey(chatId: number, userId: number): string {
  return `${chatId}${KEY_SEPARATOR}${userId}`;
}

/**
 * 某个群的键前缀，供「遍历整表挑出本群条目」的调用点做 `startsWith`。
 *
 * 刻意不提供 `isVerificationKeyOfChat(key, chatId)`：那些调用点都在遍历全表的
 * 循环里，逐键拼一次模板串等于每个键多一次分配。前缀由调用方提到循环外，
 * 格式仍然只有这一处定义。
 */
export function verificationKeyPrefix(chatId: number): string {
  return `${chatId}${KEY_SEPARATOR}`;
}

/** verificationKey 的解析结果。 */
export interface ParsedVerificationKey {
  chatId: number;
  userId: number;
}

/**
 * verificationKey 的逆函数。
 *
 * 用 `lastIndexOf` 而不是 `indexOf`：chatId 是负数（`-100...`），但它的负号在
 * 首位、不是分隔符，真正要防的是将来 userId 侧出现新分段。
 *
 * 最后拿 `verificationKey` 回打一遍做**往返校验**，而不是只查两侧是不是安全
 * 整数：`Number("")` 是 0 且通过 `Number.isSafeInteger`，于是 `"-1001:"` 会被解成
 * userId=0 这么一个看着完全合法、实际凭空捏造的目标；`" 42"`、`"+42"`、`"4e1"`
 * 同理。往返相等才说明这个键确实出自 `verificationKey`。
 *
 * 形状不符一律返回 null——调用方必须把 null 当成「这个键不可用」处理，不得拿
 * NaN 或捏造出来的 id 继续往下投递。
 */
export function parseVerificationKey(key: string): ParsedVerificationKey | null {
  const separator: number = key.lastIndexOf(KEY_SEPARATOR);
  if (separator <= 0) return null;
  const chatId: number = Number(key.slice(0, separator));
  const userId: number = Number(key.slice(separator + 1));
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId)) return null;
  if (verificationKey(chatId, userId) !== key) return null;
  return { chatId, userId };
}
