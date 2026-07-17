/** 把 Promise 按本体登记到 Set，成功或失败后再移除；多个并发请求不会覆盖。 */
export function trackInflight<T>(inflight: Set<Promise<unknown>>, request: Promise<T>): Promise<T> {
  inflight.add(request);
  void request.then(
    () => inflight.delete(request),
    () => inflight.delete(request)
  );
  return request;
}

/** 等待调用时仍登记着的全部请求。调用方应先阻止新请求继续加入。 */
export async function settleInflight(inflight: ReadonlySet<Promise<unknown>>): Promise<void> {
  await Promise.all(inflight);
}
