/**
 * 按键去重的在途任务：同键已有在途 Promise 时直接复用，否则用 create 新建并登记。
 * 结算后只释放**自己那个**槽位：整表清空后同键可能已登记新任务，无条件 delete 会删掉
 * 新任务的槽位，去重随之失效。登记表由调用方的 cache owner 持有，本模块不持有状态。
 */
export function getOrCreateKeyedTask<K, T>(
  tasks: Map<K, Promise<T>>,
  key: K,
  create: () => Promise<T>
): Promise<T> {
  const existing: Promise<T> | undefined = tasks.get(key);
  if (existing !== undefined) return existing;
  const inFlight: Promise<T> = create().finally((): void => {
    if (tasks.get(key) === inFlight) tasks.delete(key);
  });
  tasks.set(key, inFlight);
  return inFlight;
}
