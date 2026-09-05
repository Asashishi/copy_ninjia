import { expect, test } from "bun:test";
import { TEST_DATA_ROOT } from "../preloadEnv";

interface StopReport {
  readonly calls: number;
  readonly offsets: readonly number[];
  readonly size: number;
}

interface MemoryReport {
  readonly updates: number;
  readonly checkpoints: readonly Readonly<{ promiseGrowth: number; heapGrowth: number }>[];
}

function spawnRunner(mode: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([Bun.argv[0]!, "test/fixtures/updateRunner.ts", mode], {
    env: { ...Bun.env, COPY_NINJIA_DATA_ROOT: TEST_DATA_ROOT },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

for (const mode of ["network", "429"]) {
  test(`${mode} 退避在 SIGTERM 后取消 timer，不再次取数且自然退出`, async (): Promise<void> => {
    const child: ReturnType<typeof spawnRunner> = spawnRunner(mode);
    const watchdog: ReturnType<typeof setTimeout> = setTimeout((): void => child.kill("SIGKILL"), 3_000);
    const stderr: Promise<string> = child.stderr.text();
    const reader: ReturnType<typeof child.stdout.getReader> = child.stdout.getReader();
    const decoder: TextDecoder = new TextDecoder();
    let output: string = "";
    try {
      while (!output.includes("ready")) {
        const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
        if (chunk.done) throw new Error(`Missing ready signal: ${await stderr}`);
        output += decoder.decode(chunk.value);
      }
      await Bun.sleep(10);
      const start: number = performance.now();
      child.kill("SIGTERM");
      for (;;) {
        const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value);
      }
      expect(await child.exited).toBe(0);
      expect(performance.now() - start).toBeLessThan(250);
      const report: StopReport = JSON.parse(output.trim().split("\n").at(-1)!);
      expect(report.calls).toBe(mode === "network" ? 3 : 1);
      expect(report.offsets.every((offset: number): boolean => offset === 0)).toBeTrue();
      expect(report.size).toBe(0);
    } finally {
      clearTimeout(watchdog);
      child.kill();
      await child.exited;
    }
  });
}

test("连续 10 万条更新不累计常驻 Promise 或堆，并且逐条处理恰好一次", async (): Promise<void> => {
  const child: ReturnType<typeof spawnRunner> = spawnRunner("memory");
  const stdout: Promise<string> = child.stdout.text();
  const stderr: Promise<string> = child.stderr.text();
  const watchdog: ReturnType<typeof setTimeout> = setTimeout((): void => child.kill("SIGKILL"), 10_000);
  try {
    const code: number = await child.exited;
    if (code !== 0) throw new Error(await stderr);
    const report: MemoryReport = JSON.parse(await stdout);
    expect(report.updates).toBe(120_000);
    expect(report.checkpoints).toHaveLength(4);
    for (const checkpoint of report.checkpoints) {
      expect(checkpoint.promiseGrowth).toBeLessThan(1_000);
      expect(checkpoint.heapGrowth).toBeLessThan(512 * 1_024);
    }
  } finally {
    clearTimeout(watchdog);
    child.kill();
    await child.exited;
  }
}, 15_000);
