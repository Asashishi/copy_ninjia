import { describe, expect, test } from "bun:test";
import { ApplicationLifecycle, createApplicationLifecycle } from "../../src/app/lifecycle";

describe("application lifecycle", () => {
  test("构造与空 dispose 都没有启动 Worker、联网或写盘，dispose 幂等", async () => {
    const lifecycle = createApplicationLifecycle();
    expect(lifecycle).toBeInstanceOf(ApplicationLifecycle);
    await lifecycle.dispose();
    await lifecycle.dispose();
  });

  test("未 init 时不能等待 runner", async () => {
    await expect(new ApplicationLifecycle().wait()).rejects.toThrow(
      "Application lifecycle has not been initialized"
    );
  });
});
