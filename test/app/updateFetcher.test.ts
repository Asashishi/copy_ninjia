import { expect, spyOn, test } from "bun:test";
import { createUpdateFetcher } from "@grammyjs/runner";
import { createAcknowledgedUpdateFetcher } from "../../packages/app/updateFetcher";
import {
  UPDATE_POLL_INITIAL_RETRY_MS,
  UPDATE_POLL_MAX_RETRY_MS,
  UPDATE_POLL_RETRY_WINDOW_MS,
} from "../../packages/consts/updateRunner";

interface FetchTrace {
  readonly requests: readonly unknown[];
  readonly delays: readonly number[];
  readonly outputs: readonly unknown[];
}

interface FetchScenario {
  readonly name: string;
  readonly results: readonly unknown[];
  readonly rounds?: number;
}

interface TraceOptions {
  readonly rounds?: number;
  /** 这个假时刻之前的请求一律抛 network，之后按 results 依次返回。 */
  readonly failUntil?: number;
}

async function trace(
  candidate: boolean,
  results: readonly unknown[],
  { rounds = 1, failUntil = 0 }: TraceOptions = {}
): Promise<FetchTrace> {
  let now: number = 1_000_000;
  let calls: number = 0;
  const requests: unknown[] = [];
  const delays: number[] = [];
  const outputs: unknown[] = [];
  // 两个时钟都要假：参照实现按墙钟算重试预算，本仓库实现按 performance.now()
  // 的单调时钟算（见 libs/monotonicDeadline.ts）。
  const clock: ReturnType<typeof spyOn<typeof Date, "now">> = spyOn(Date, "now").mockImplementation((): number => now);
  const monotonic: ReturnType<typeof spyOn<Performance, "now">> = spyOn(performance, "now").mockImplementation((): number => now);
  const stderr: ReturnType<typeof spyOn<typeof console, "error">> = spyOn(console, "error").mockImplementation((): void => {});
  const timers: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">> = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number): number => {
    delays.push(delay);
    queueMicrotask((): void => { now += delay; callback(); });
    return 1;
  }) as never);
  const bot: { readonly api: { getUpdates(args: unknown): Promise<unknown[]> } } = {
    api: { getUpdates: async (args: unknown): Promise<unknown[]> => {
      requests.push({ ...(args as object), at: now });
      if (now < failUntil) throw new Error("network");
      const value: unknown = results[Math.min(calls++, results.length - 1)];
      if (Array.isArray(value)) return value;
      throw value;
    } },
  };
  const control: AbortController = new AbortController();
  const existing: ReturnType<typeof createUpdateFetcher> = createUpdateFetcher(bot as never, { fetch: { allowed_updates: ["message"] } });
  const proposed: ReturnType<typeof createAcknowledgedUpdateFetcher> = createAcknowledgedUpdateFetcher(bot.api as never, ["message"]);
  try {
    for (let i: number = 0; i < rounds; i++) {
      try {
        outputs.push(await (candidate ? proposed(control.signal) : existing(1, control.signal as never)));
      } catch (error: unknown) {
        outputs.push(error);
        break;
      }
    }
  } finally {
    timers.mockRestore(); clock.mockRestore(); monotonic.mockRestore(); stderr.mockRestore();
  }
  return { requests, delays, outputs };
}

// 参照实现（@grammyjs/runner）的指数退避不封顶；只在退避尚未触顶的场景逐项对拍，
// 触顶之后的行为由下面两条独立用例锁定。
const scenarios: readonly FetchScenario[] = [
  { name: "成功、空响应与 offset", results: [[{ update_id: 10 }], [], [{ update_id: 12 }]], rounds: 3 },
  { name: "网络失败恢复与下一批重置退避", results: [new Error("network"), new Error("network"), [{ update_id: 10 }], new Error("again"), [{ update_id: 11 }]], rounds: 2 },
  { name: "401 不重试", results: [{ error_code: 401 }] },
  { name: "409 不重试", results: [{ error_code: 409 }] },
  { name: "429 先等待 retry_after 再指数退避", results: [{ error_code: 429, parameters: { retry_after: 0.125 } }, [{ update_id: 10 }]] },
  { name: "无 retry_after 的 429", results: [{ error_code: 429 }, [{ update_id: 10 }]] },
];
for (const scenario of scenarios) {
  test(scenario.name, async (): Promise<void> => {
    const original: FetchTrace = await trace(false, scenario.results, { rounds: scenario.rounds });
    const candidate: FetchTrace = await trace(true, scenario.results, { rounds: scenario.rounds });
    expect(candidate).toEqual(original);
  });
}

test.each([UPDATE_POLL_RETRY_WINDOW_MS, UPDATE_POLL_RETRY_WINDOW_MS + 1_000])(
  "429 等待达到或超过重试预算时不创建等待：%d", async (retryAfterMs: number): Promise<void> => {
    const error: Readonly<{ error_code: number; parameters: Readonly<{ retry_after: number }> }> = {
      error_code: 429, parameters: { retry_after: retryAfterMs / 1_000 },
    };
    const result: FetchTrace = await trace(true, [error]);
    expect(result.delays).toEqual([]);
    expect(result.requests).toHaveLength(1);
    expect(result.outputs).toEqual([error]);
  }
);

test("连续失败后的 429 等待共用剩余重试预算", async (): Promise<void> => {
  const errors: readonly unknown[] = [new Error("network"), {
    error_code: 429, parameters: { retry_after: UPDATE_POLL_RETRY_WINDOW_MS / 1_000 },
  }];
  const result: FetchTrace = await trace(true, errors);
  expect(result.delays).toEqual([UPDATE_POLL_INITIAL_RETRY_MS]);
  expect(result.requests).toHaveLength(errors.length);
  expect(result.outputs).toEqual([errors[1]]);
});

test("429 等待期间取消会撤回定时器并传播取消原因", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  const reason: Error = new Error("cancel polling");
  const stderr = spyOn(console, "error").mockImplementation((): void => {});
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((_callback: () => void): number => {
    queueMicrotask((): void => { controller.abort(reason); });
    return 1;
  }) as never);
  const clearing = spyOn(globalThis, "clearTimeout").mockImplementation((): void => {});
  const api: { getUpdates(): Promise<never> } = {
    getUpdates: async (): Promise<never> => { throw { error_code: 429, parameters: { retry_after: 1 } }; },
  };
  try {
    await expect(createAcknowledgedUpdateFetcher(api, ["message"])(controller.signal)).rejects.toBe(reason);
    expect(clearing).toHaveBeenCalledWith(1);
  } finally { clearing.mockRestore(); timers.mockRestore(); stderr.mockRestore(); }
});

test("持续失败时退避翻倍后封顶，并在重试窗口内抛出最后一次错误", async (): Promise<void> => {
  const { delays, outputs, requests }: FetchTrace = await trace(true, [new Error("persistent")]);
  expect(delays[0]).toBe(UPDATE_POLL_INITIAL_RETRY_MS);
  for (let index: number = 1; index < delays.length; index++) {
    expect(delays[index]).toBe(Math.min(delays[index - 1]! * 2, UPDATE_POLL_MAX_RETRY_MS));
  }
  expect(Math.max(...delays)).toBe(UPDATE_POLL_MAX_RETRY_MS);
  const waited: number = delays.reduce((sum: number, delay: number): number => sum + delay, 0);
  expect(waited).toBeLessThanOrEqual(UPDATE_POLL_RETRY_WINDOW_MS);
  expect(waited + UPDATE_POLL_MAX_RETRY_MS).toBeGreaterThan(UPDATE_POLL_RETRY_WINDOW_MS);
  expect(requests).toHaveLength(delays.length + 1);
  expect(outputs).toEqual([new Error("persistent")]);
});

test("断网恢复后最多再等一个封顶退避就重新取数", async (): Promise<void> => {
  const outageMs: number = 30 * 60_000;
  const { requests, outputs }: FetchTrace = await trace(true, [[{ update_id: 10 }]], { failUntil: 1_000_000 + outageMs });
  const recoveredAt: number = (requests[requests.length - 1] as { at: number }).at;
  expect(outputs).toEqual([[{ update_id: 10 }]]);
  expect(recoveredAt - (1_000_000 + outageMs)).toBeLessThanOrEqual(UPDATE_POLL_MAX_RETRY_MS);
});
