/**
 * 轮询直到条件成立，或预算耗尽。返回条件最终是否成立；到点仍不成立时不抛错，
 * 由紧随其后那条带具体数值的断言给出失败信息。
 *
 * 用它等「某个可观测状态出现」，不用固定时长的 sleep 加断言。
 *
 * 负向断言（「这段时间内不该发生」）不适用本助手，那类等待仍用固定时长。
 */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs: number = 2_000
): Promise<boolean> {
  const deadline: number = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) return condition();
    await Bun.sleep(1);
  }
  return true;
}
