import {
  blocklistIdentityMutationQueues,
  protectedIdentityMutationQueue,
} from "../../cache/main/blocklist";

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

/**
 * 按身份串行执行动态黑名单的完整业务副作用。
 *
 * 与全局 protected-identity 队列职责不同：后者只守白名单/黑名单互斥的短临界
 * 区；本队列允许同一身份的落盘与 Telegram 副作用跨 await，以保证后到的
 * `/unblock` 一定排在较早广告封禁之后完成，同时不阻塞无关身份。
 */
export function runBlocklistIdentityMutation<T>(
  identityId: number,
  mutation: () => T | Promise<T>
): Promise<T> {
  const previous: Promise<void> = blocklistIdentityMutationQueues.get(identityId) ?? Promise.resolve();
  const result: Promise<T> = previous.then(mutation);
  const tail: Promise<void> = result.then(
    (): void => undefined,
    (): void => undefined
  );
  blocklistIdentityMutationQueues.set(identityId, tail);
  void tail.then((): void => {
    if (blocklistIdentityMutationQueues.get(identityId) === tail) {
      blocklistIdentityMutationQueues.delete(identityId);
    }
  });
  return result;
}
