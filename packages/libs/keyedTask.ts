/**
 * 按键去重的在途任务：同键已有在途 Promise 时直接复用，否则用 create 新建并登记。
 * 结算后只释放自己登记的槽位（按 Promise 身份比对），整表清空后同键登记的新任务不受影响。
 * 登记表由调用方的 cache owner 持有，本模块不持有状态。
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
