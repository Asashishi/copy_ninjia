import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { heapStats } from "bun:jsc";
import { runAcknowledgedUpdateBatches } from "../../packages/app/updateRunner";
import type { AcknowledgedUpdateRunner } from "../../packages/types/lifecycle";

interface MockBot {
  readonly api: {
    getUpdates(args: { offset: number }, signal: AbortSignal): Promise<Update[]>;
  };
  handleUpdate(update: Update): Promise<void>;
  errorHandler(): void;
}

interface MemoryCheckpoint {
  readonly nsPerOp: number;
  readonly heapGrowth: number;
  readonly promiseGrowth: number;
}

const mode: string = Bun.argv[2] ?? "memory";

if (mode !== "memory") {
  let calls: number = 0;
  const offsets: number[] = [];
  const bot: MockBot = {
    api: {
      getUpdates: async (args: { offset: number }): Promise<never> => {
        offsets.push(args.offset);
        calls++;
        if ((mode === "network" && calls === 3) || mode === "429") console.log("ready");
        if (mode === "429") throw { error_code: 429, parameters: { retry_after: 60 } };
        throw new Error("mock network failure");
      },
    },
    handleUpdate: async (): Promise<void> => {},
    errorHandler: (): void => {},
  };
  const runner: AcknowledgedUpdateRunner = runAcknowledgedUpdateBatches(bot as unknown as Bot, ["message"]);
  process.once("SIGTERM", async (): Promise<void> => {
    const start: number = performance.now();
    await runner.stop();
    await runner.stop();
    console.log(JSON.stringify({ calls, offsets, stopMs: performance.now() - start, size: runner.size() }));
  });
  await runner.task();
} else {
  let updates: number = 0;
  let target: number = 0;
  let pause: (() => void) | undefined;
  let reached: (() => void) | undefined;
  let checksum: number = 0;
  const bot: MockBot = {
    api: {
      getUpdates: async (_args: unknown, signal: AbortSignal): Promise<Update[]> => {
        if (updates === target) {
          reached?.();
          await new Promise<void>((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
            const abort = (): void => reject(new Error("aborted"));
            signal.addEventListener("abort", abort, { once: true });
            pause = (): void => { signal.removeEventListener("abort", abort); resolve(); };
          });
        }
        updates++;
        return [{ update_id: updates }];
      },
    },
    handleUpdate: async (update: Update): Promise<void> => { checksum += update.update_id; },
    errorHandler: (): void => {},
  };
  const runner: AcknowledgedUpdateRunner = runAcknowledgedUpdateBatches(bot as unknown as Bot, ["message"]);
  async function batch(count: number): Promise<void> {
    const done: Promise<void> = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void): void => { reached = resolve; });
    target += count;
    pause?.();
    await done;
    await Bun.sleep(0);
  }
  await Bun.sleep(0);
  await batch(20_000);
  Bun.gc(true);
  const before: ReturnType<typeof heapStats> = heapStats();
  const checkpoints: MemoryCheckpoint[] = [];
  for (let round: number = 0; round < 4; round++) {
    const start: number = Bun.nanoseconds();
    await batch(25_000);
    const nsPerOp: number = (Bun.nanoseconds() - start) / 25_000;
    Bun.gc(true);
    const current: ReturnType<typeof heapStats> = heapStats();
    checkpoints.push({
      nsPerOp,
      heapGrowth: current.heapSize - before.heapSize,
      promiseGrowth: (current.objectTypeCounts.Promise ?? 0) - (before.objectTypeCounts.Promise ?? 0),
    });
  }
  await runner.stop();
  if (runner.size() !== 0 || checksum !== updates * (updates + 1) / 2) {
    throw new Error("Runner did not complete every mock update exactly once.");
  }
  console.log(JSON.stringify({ checkpoints, updates, checksum }));
}
