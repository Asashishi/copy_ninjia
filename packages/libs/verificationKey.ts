import { KEY_SEPARATOR } from "../consts/verificationKey";

export function verificationKey(chatId: number, userId: number): string {
  return `${chatId}${KEY_SEPARATOR}${userId}`;
}

/**
 * 某个群的键前缀，供「遍历整表挑出本群条目」的调用点做 `startsWith`；前缀由调用方
 * 提到循环外，格式只有这一处定义。
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
 * 用 `lastIndexOf` 定位分隔符；chatId 的负号在首位，不参与分隔。
 *
 * 最后拿 `verificationKey` 回打一遍做往返校验，不只查两侧是不是安全整数：
 * `"-1001:"`、`" 42"`、`"+42"`、`"4e1"` 经 `Number` 后都通过安全整数判定，但回打结果与
 * 原键不等。往返相等才说明这个键出自 `verificationKey`。
 *
 * 形状不符一律返回 null；调用方把 null 当成「这个键不可用」处理。
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

/**
 * 解析本线程自己用 verificationKey 生成的键；形状不符说明内部表被写坏，按不变量
 * 违例抛错。来自线程外的键仍用 parseVerificationKey 并自行处理 null。
 */
export function requireVerificationKey(key: string): ParsedVerificationKey {
  const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
  if (parsed === null) throw new Error(`Verification key was not produced by verificationKey: ${key}`);
  return parsed;
}
