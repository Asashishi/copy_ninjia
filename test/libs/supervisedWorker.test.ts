import { describe, expect, spyOn, test } from "bun:test";
import { WORKER_MAX_RESTARTS } from "../../packages/consts/workerSupervisor";
import { setBusinessWorkerFatalHandler } from "../../packages/infra/workerSupervisor";
import { superviseWorker } from "../../packages/libs/supervisedWorker";
import type { SupervisedWorkerEventContext } from "../../packages/libs/supervisedWorker";
import type { SupervisedWorkerFixtureCommand, SupervisedWorkerFixtureReply } from "./supervisedWorker.fixture";

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  static nextPostError: Error | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminated: boolean = false;
  postError: Error | null;

  constructor(readonly url: string) {
    this.postError = FakeWorker.nextPostError;
    FakeWorker.nextPostError = null;
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: unknown): void {
    if (this.postError !== null) throw this.postError;
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("supervised Worker", () => {
  test("真实 Worker 崩溃后重建并由 onRespawn 重放状态", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let resolveReplay!: (reply: SupervisedWorkerFixtureReply) => void;
    const replayed = new Promise<SupervisedWorkerFixtureReply>((resolve) => { resolveReplay = resolve; });
    const handle = superviseWorker<SupervisedWorkerFixtureCommand, SupervisedWorkerFixtureReply>({
      url: new URL("./supervisedWorker.fixture.ts", import.meta.url).href,
      label: "test Worker",
      giveUpConsequence: "test feature unavailable",
      onEvent: (event) => {
        if (event.value === "restored") resolveReplay(event);
      },
      onRespawn: (post) => post({ type: "echo", value: "restored" }),
    });

    try {
      handle.init();
      expect(handle.post({ type: "crash" })).toBeTrue();
      await expect(within(replayed, 3_000)).resolves.toEqual({ type: "echo", value: "restored" });
      expect(handle.post({ type: "echo", value: "still-available" })).toBeTrue();
    } finally {
      await handle.terminate();
      error.mockRestore();
    }
  });

  test("真实 Worker 耗尽重启预算后 give up，后续投递安静失败", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let respawns: number = 0;
    let giveUps: number = 0;
    let resolveGiveUp!: () => void;
    const gaveUp = new Promise<void>((resolve) => { resolveGiveUp = resolve; });
    const handle = superviseWorker<SupervisedWorkerFixtureCommand>({
      url: new URL("./supervisedWorker.fixture.ts", import.meta.url).href,
      label: "test Worker",
      giveUpConsequence: "test feature unavailable",
      onRespawn: (post) => {
        respawns++;
        post({ type: "crash" });
      },
      onGiveUp: () => {
        giveUps++;
        resolveGiveUp();
      },
    });

    try {
      handle.init();
      expect(handle.post({ type: "crash" })).toBeTrue();
      await within(gaveUp, 5_000);
      expect(respawns).toBe(WORKER_MAX_RESTARTS);
      expect(giveUps).toBe(1);
      expect(handle.post({ type: "echo", value: "dropped" })).toBeFalse();
    } finally {
      await handle.terminate();
      error.mockRestore();
    }
  });

  test("替换或终止后的旧实例迟到业务事件与错误均被丢弃", async () => {
    FakeWorker.instances.length = 0;
    FakeWorker.nextPostError = null;
    const originalWorker: typeof Worker = globalThis.Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const events: string[] = [];
    let respawns: number = 0;
    const handle = superviseWorker<{ type: "restore" }, string>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onEvent: (event) => { events.push(event); },
      onRespawn: (post) => {
        respawns++;
        post({ type: "restore" });
      },
    });

    try {
      handle.init();
      handle.init();
      const first: FakeWorker = FakeWorker.instances[0]!;
      expect(FakeWorker.instances).toHaveLength(1);

      first.onerror!({ message: "boom" } as ErrorEvent);
      const second: FakeWorker = FakeWorker.instances[1]!;
      expect(second.messages).toEqual([{ type: "restore" }]);

      first.onmessage!({ data: "stale" } as MessageEvent<unknown>);
      first.onerror!({ message: "late boom" } as ErrorEvent);
      second.onmessage!({ data: "current" } as MessageEvent<unknown>);
      expect(events).toEqual(["current"]);
      expect(respawns).toBe(1);
      expect(FakeWorker.instances).toHaveLength(2);

      second.postError = new Error("post rejected");
      expect(handle.post({ type: "restore" })).toBeFalse();
      expect(second.messages).toEqual([{ type: "restore" }]);
      expect(error).toHaveBeenCalledWith(
        "fake Worker postMessage failed:",
        expect.objectContaining({ message: "post rejected" })
      );

      await handle.terminate();
      second.onerror!({ message: "after terminate" } as ErrorEvent);
      expect(FakeWorker.instances).toHaveLength(2);
      expect(second.terminated).toBeTrue();
      expect(handle.post({ type: "restore" })).toBeFalse();
    } finally {
      await handle.terminate();
      globalThis.Worker = originalWorker;
      error.mockRestore();
    }
  });

  test("重放被新实例同步拒绝时撤销该实例并进入永久不可用状态", async () => {
    FakeWorker.instances.length = 0;
    FakeWorker.nextPostError = null;
    const originalWorker: typeof Worker = globalThis.Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    let giveUps: number = 0;
    const fatalErrors: Error[] = [];
    setBusinessWorkerFatalHandler((failure: Error): void => {
      fatalErrors.push(failure);
    });
    const handle = superviseWorker<{ type: "restore" }>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onRespawn: (post) => {
        post({ type: "restore" });
      },
      onGiveUp: () => {
        giveUps++;
      },
    });

    try {
      handle.init();
      const first: FakeWorker = FakeWorker.instances[0]!;
      FakeWorker.nextPostError = new Error("replay rejected");

      expect(() => first.onerror!({ message: "boom" } as ErrorEvent)).not.toThrow();

      const second: FakeWorker = FakeWorker.instances[1]!;
      expect(second.messages).toEqual([]);
      expect(second.terminated).toBeTrue();
      expect(giveUps).toBe(1);
      expect(handle.post({ type: "restore" })).toBeFalse();
      expect(fatalErrors[0]?.message).toContain("state replay was rejected");
    } finally {
      await handle.terminate();
      setBusinessWorkerFatalHandler(undefined);
      globalThis.Worker = originalWorker;
      FakeWorker.nextPostError = null;
      error.mockRestore();
    }
  });

  test("当前代际的事件回包被同步拒绝时撤销实例，避免 Worker waiter 永久悬挂", async () => {
    FakeWorker.instances.length = 0;
    FakeWorker.nextPostError = null;
    const originalWorker: typeof Worker = globalThis.Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const fatalErrors: Error[] = [];
    setBusinessWorkerFatalHandler((failure: Error): void => {
      fatalErrors.push(failure);
    });
    const handle = superviseWorker<{ type: "reply" }, string>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onEvent: (
        _event: string,
        context: SupervisedWorkerEventContext<{ type: "reply" }>
      ): void => {
        context.post({ type: "reply" });
      },
    });

    try {
      handle.init();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      worker.postError = new Error("reply rejected");
      worker.onmessage!({ data: "request" } as MessageEvent<unknown>);

      expect(worker.terminated).toBeTrue();
      expect(handle.post({ type: "reply" })).toBeFalse();
      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("event response delivery was rejected");
    } finally {
      await handle.terminate();
      setBusinessWorkerFatalHandler(undefined);
      globalThis.Worker = originalWorker;
      FakeWorker.nextPostError = null;
      error.mockRestore();
    }
  });
});
