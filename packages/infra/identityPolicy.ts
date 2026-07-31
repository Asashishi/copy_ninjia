import { protectedIdentityMutationQueue } from "../cache/main/blocklist";

/**
 * 串行执行会改变「白名单成员 / 动态黑名单成员」互斥关系的主线程操作。
 * 调用方只把身份检查与权威内存变更放进临界区；Telegram 副作用和后续落盘确认
 * 留在外面，避免一个慢群阻塞无关身份的低频策略修改。
 */
export function runProtectedIdentityMutation<T>(
  mutation: () => T | Promise<T>
): Promise<T> {
  const result: Promise<T> = protectedIdentityMutationQueue.current.then(mutation);
  protectedIdentityMutationQueue.current = result.then(
    (): void => undefined,
    (): void => undefined
  );
  return result;
}
