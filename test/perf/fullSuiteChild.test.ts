import { describe, expect, test } from "bun:test";
import { spawnJsonChild } from "../../scripts/perf/fullSuite/child";

interface Payload {
  readonly ok: number;
}

describe("基准子进程编排", () => {
  test("把子进程 stdout 解析成结构化结果", async () => {
    const result: Payload = await spawnJsonChild<Payload>({
      args: ["-e", "console.log(JSON.stringify({ ok: 7 }))"],
      label: "fixture",
    });
    expect(result.ok).toBe(7);
  });

  test("追加的环境变量能传进子进程", async () => {
    const result: Payload = await spawnJsonChild<Payload>({
      args: ["-e", "console.log(JSON.stringify({ ok: Number(process.env.PERF_FIXTURE) }))"],
      env: { PERF_FIXTURE: "42" },
      label: "fixture",
    });
    expect(result.ok).toBe(42);
  });

  test("成功时把完整 stderr 交给回调，回调抛错按本次调用失败", async () => {
    const received: string[] = [];
    const result: Payload = await spawnJsonChild<Payload>({
      args: ["-e", "console.error('gc-log'); console.log(JSON.stringify({ ok: 1 }))"],
      label: "fixture",
      onStderr: (stderr: string): void => { received.push(stderr); },
    });
    expect(result.ok).toBe(1);
    expect(received).toEqual(["gc-log\n"]);
    await expect(spawnJsonChild<Payload>({
      args: ["-e", "console.log(JSON.stringify({ ok: 1 }))"],
      label: "fixture",
      onStderr: (): void => { throw new Error("incomplete log"); },
    })).rejects.toThrow("incomplete log");
  });

  test("失败的子进程不调用 stderr 回调", async () => {
    const received: string[] = [];
    await expect(spawnJsonChild<Payload>({
      args: ["-e", "console.error('boom'); process.exit(3)"],
      label: "fixture",
      onStderr: (stderr: string): void => { received.push(stderr); },
    })).rejects.toThrow("exited 3");
    expect(received).toEqual([]);
  });

  test("非零退出时带上 stderr 抛错，不返回半截读数", async () => {
    await expect(spawnJsonChild<Payload>({
      args: ["-e", "console.error('boom'); process.exit(3)"],
      label: "fixture",
    })).rejects.toThrow("fixture: benchmark child exited 3. boom");
  });

  test("stdout 为空或不是 JSON 时一律失败", async () => {
    await expect(spawnJsonChild<Payload>({
      args: ["-e", "process.exit(0)"],
      label: "fixture",
    })).rejects.toThrow("produced no result");
    await expect(spawnJsonChild<Payload>({
      args: ["-e", "console.log('not json')"],
      label: "fixture",
    })).rejects.toThrow("did not return JSON");
  });
});

describe("基准子进程超时", () => {
  test("超出预算的子进程被杀掉，并按超时报而不是伪装成崩溃", async () => {
    await expect(spawnJsonChild<Payload>({
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      label: "fixture",
      timeoutMs: 250,
    })).rejects.toThrow("fixture: benchmark child exceeded 250 ms and was killed.");
  });
});
