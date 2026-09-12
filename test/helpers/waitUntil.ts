/**
 * 轮询直到条件成立，或预算耗尽。返回条件最终是否成立；到点仍不成立时**不抛错**，
 * 让紧随其后那条带具体数值的断言给出真正的失败信息，而不是一句「timed out」。
 *
 * 用它替代「sleep 一个猜出来的时长再断言」：固定时长把调度器在这台机器、这个负载下
 * 恰好转几圈当成了契约，链路多一次 await、或者 CPU 被别的测试文件争用，断言就会读到
 * 尚未发生的结果。需要等的是"某个可观测状态出现"，就直接等它。
 *
 * 负向断言（「这段时间内不该发生」）不适用本助手，那类等待仍只能是固定时长。
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
