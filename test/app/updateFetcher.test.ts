import { expect, spyOn, test } from "bun:test";
import { createUpdateFetcher } from "@grammyjs/runner";
import { createAcknowledgedUpdateFetcher } from "../../packages/app/updateFetcher";

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

async function trace(candidate: boolean, results: readonly unknown[], rounds: number = 1): Promise<FetchTrace> {
  let now: number = 1_000_000;
  let calls: number = 0;
  const requests: unknown[] = [];
  const delays: number[] = [];
  const outputs: unknown[] = [];
  const clock: ReturnType<typeof spyOn<typeof Date, "now">> = spyOn(Date, "now").mockImplementation((): number => now);
  const stderr: ReturnType<typeof spyOn<typeof console, "error">> = spyOn(console, "error").mockImplementation((): void => {});
  const timers: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">> = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number): number => {
    delays.push(delay);
    queueMicrotask((): void => { now += delay; callback(); });
    return 1;
  }) as never);
  const bot: { readonly api: { getUpdates(args: unknown): Promise<unknown[]> } } = {
    api: { getUpdates: async (args: unknown): Promise<unknown[]> => {
      requests.push({ ...(args as object), at: now });
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
    timers.mockRestore(); clock.mockRestore(); stderr.mockRestore();
  }
  return { requests, delays, outputs };
}

const scenarios: readonly FetchScenario[] = [
  { name: "成功、空响应与 offset", results: [[{ update_id: 10 }], [], [{ update_id: 12 }]], rounds: 3 },
  { name: "网络失败恢复与下一批重置退避", results: [new Error("network"), new Error("network"), [{ update_id: 10 }], new Error("again"), [{ update_id: 11 }]], rounds: 2 },
  { name: "401 不重试", results: [{ error_code: 401 }] },
  { name: "409 不重试", results: [{ error_code: 409 }] },
  { name: "429 先等待 retry_after 再指数退避", results: [{ error_code: 429, parameters: { retry_after: 0.125 } }, [{ update_id: 10 }]] },
  { name: "无 retry_after 的 429", results: [{ error_code: 429 }, [{ update_id: 10 }]] },
  { name: "15 小时重试预算", results: [new Error("persistent")] },
  { name: "retry_after 超过重试预算", results: [{ error_code: 429, parameters: { retry_after: 54_100 } }] },
];
for (const scenario of scenarios) {
  test(scenario.name, async (): Promise<void> => {
    const original: FetchTrace = await trace(false, scenario.results, scenario.rounds);
    const candidate: FetchTrace = await trace(true, scenario.results, scenario.rounds);
    expect(candidate).toEqual(original);
  });
}
