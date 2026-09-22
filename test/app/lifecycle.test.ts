import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import { ApplicationLifecycle } from "../../packages/app/lifecycle";
import { TEST_DATA_ROOT } from "../preloadEnv";

/** 测试数据根下的全部路径（相对），用于核对某段操作没有落任何盘。 */
function dataRootEntries(): string[] {
  return readdirSync(TEST_DATA_ROOT, { recursive: true, encoding: "utf8" }).sort();
}

describe("application lifecycle", () => {
  test("构造与空 dispose 都没有启动 Worker、联网或写盘，dispose 幂等", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    let workerConstructions: number = 0;
    globalThis.Worker = function refuseWorker(): never {
      workerConstructions++;
      throw new Error("lifecycle must not start a Worker before init");
    } as unknown as typeof Worker;
    const fetchSpy = spyOn(globalThis, "fetch");
    const writeSpy = spyOn(Bun, "write");
    const before: string[] = dataRootEntries();
    try {
      const lifecycle = new ApplicationLifecycle();
      await lifecycle.dispose();
      await lifecycle.dispose();

      expect(workerConstructions).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(dataRootEntries()).toEqual(before);
    } finally {
      globalThis.Worker = originalWorker;
      fetchSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("未 init 时不能等待 runner", async () => {
    await expect(new ApplicationLifecycle().wait()).rejects.toThrow(
      "Application lifecycle has not been initialized"
    );
  });
});
