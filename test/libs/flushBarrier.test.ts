import { describe, expect, test } from "bun:test";
import { createFlushBarrier } from "../../src/libs/flushBarrier";

describe("flush barrier", () => {
  test("ack 只结算一次并忽略迟到回执", async () => {
    const barrier = createFlushBarrier({ timeoutMs: 1_000 });
    let id: number = 0;
    const result = barrier.begin((nextId) => { id = nextId; });

    expect(barrier.pendingCount()).toBe(1);
    expect(barrier.settle(id, "flushed")).toBeTrue();
    expect(barrier.settle(id, "failed")).toBeFalse();
    await expect(result).resolves.toBe("flushed");
    expect(barrier.pendingCount()).toBe(0);
  });

  test("超时、投递失败和同步异常都清理等待项", async () => {
    const barrier = createFlushBarrier({ timeoutMs: 1 });

    await expect(barrier.begin(() => undefined)).resolves.toBe("timedOut");
    await expect(barrier.begin(() => false, 1_000)).resolves.toBe("failed");
    await expect(barrier.begin(() => { throw new Error("post failed"); }, 1_000)).resolves.toBe("failed");
    expect(barrier.pendingCount()).toBe(0);
  });

  test("崩溃会立即按同一结果结算所有在途等待", async () => {
    const barrier = createFlushBarrier({ timeoutMs: 60_000 });
    const first = barrier.begin(() => undefined);
    const second = barrier.begin(() => undefined);

    barrier.settleAll("failed");

    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      { status: "fulfilled", value: "failed" },
      { status: "fulfilled", value: "failed" },
    ]);
    expect(barrier.pendingCount()).toBe(0);
  });
});
