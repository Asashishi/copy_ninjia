import { describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../../packages/consts/workerSupervisor";
import {
  initDiskIO,
  isDiskIOInitialized,
  loadPersistedData,
  terminateDiskIO,
} from "../../packages/infra/diskIO";
import { setBusinessWorkerFatalHandler } from "../../packages/infra/workerSupervisor";
import { superviseWorker } from "../../packages/infra/supervisedWorker";
import type {
  SupervisedWorkerEventContext,
  SupervisedWorkerHandle,
} from "../../packages/infra/supervisedWorker";
import type { ForwardedLogBatch, LogMessage } from "../../packages/types/diskIO/messages";
import {
  emitSuccessfulDiskIOLoad,
  FakeDiskIOWorker,
  installFakeDiskIOWorker,
  lastDiskIOMessage,
} from "../helpers/diskIOWorkerHarness";
import type { SupervisedWorkerFixtureCommand, SupervisedWorkerFixtureReply } from "./supervisedWorker.fixture";

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 替身要同步抛出的任意值（含非 Error）；用包装区分「不抛」与「抛 undefined」。 */
interface ThrownValue {
  readonly value: unknown;
}

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  static nextPostError: Error | null = null;
  /** 让**下一次**构造直接抛出；消费后即复位，失败的构造不进入 instances。 */
  static nextConstructFailure: ThrownValue | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminated: boolean = false;
  postError: Error | null;
  /** 非 null 时 terminate() 先记下已调用，再同步抛出其中的值。 */
  terminateFailure: ThrownValue | null = null;

  constructor(readonly url: string) {
    const constructFailure: ThrownValue | null = FakeWorker.nextConstructFailure;
    FakeWorker.nextConstructFailure = null;
    if (constructFailure !== null) throw constructFailure.value;
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
    if (this.terminateFailure !== null) throw this.terminateFailure.value;
  }
}

/** 取最近一个构造成功的替身；没有就是用例前提没成立，直接抛。 */
function latestFakeWorker(): FakeWorker {
  const worker: FakeWorker | undefined = FakeWorker.instances.at(-1);
  if (worker === undefined) throw new Error("no fake Worker has been constructed");
  return worker;
}

interface FakeWorkerScope {
  /** signalBusinessWorkerFatal 按到达顺序收到的永久不可用原因。 */
  readonly fatalErrors: Error[];
  /** 静音后的 console.error；主线程 logger.error 序列化后的参数经它输出。 */
  readonly consoleError: Mock<typeof console.error>;
  /** 清掉替身上的 terminate 故障并还原 Worker 构造器、fatal 接收者与 console.error。 */
  readonly restore: () => void;
}

/**
 * 换上 FakeWorker 并捕获业务 Worker fatal。finally 里先 restore 再 terminate 句柄：
 * terminate 不再构造 Worker，而先清掉故障才不会让清理本身被故障替身打断。
 */
function installFakeWorkerScope(): FakeWorkerScope {
  FakeWorker.instances.length = 0;
  FakeWorker.nextPostError = null;
  FakeWorker.nextConstructFailure = null;
  const originalWorker: typeof Worker = globalThis.Worker;
  const consoleError: Mock<typeof console.error> = spyOn(console, "error").mockImplementation((): void => {});
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const fatalErrors: Error[] = [];
  setBusinessWorkerFatalHandler((failure: Error): void => {
    fatalErrors.push(failure);
  });
  return {
    fatalErrors,
    consoleError,
    restore: (): void => {
      for (const instance of FakeWorker.instances) instance.terminateFailure = null;
      setBusinessWorkerFatalHandler(undefined);
      globalThis.Worker = originalWorker;
      FakeWorker.nextPostError = null;
      FakeWorker.nextConstructFailure = null;
      consoleError.mockRestore();
    },
  };
}

function logMessage(text: string, timestamp: number): LogMessage {
  return { timestamp, level: "error", args: [text] };
}

function logBatchEvent(batchId: number, messages: readonly LogMessage[]): MessageEvent<unknown> {
  const batch: ForwardedLogBatch = { __logBatch: { batchId, messages } };
  return { data: batch } as MessageEvent<unknown>;
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

  test("DiskIO 未初始化时 Worker 日志批次不 ACK、不交给 onEvent，实例继续可用", async () => {
    const scope: FakeWorkerScope = installFakeWorkerScope();
    const events: unknown[] = [];
    const handle: SupervisedWorkerHandle<{ type: "ping" }> = superviseWorker<{ type: "ping" }, unknown>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onEvent: (event: unknown): void => {
        events.push(event);
      },
    });

    try {
      expect(isDiskIOInitialized()).toBeFalse();
      handle.init();
      const worker: FakeWorker = latestFakeWorker();

      worker.onmessage!(logBatchEvent(3, [
        logMessage("worker boom", 1),
        logMessage("worker boom again", 2),
      ]));
      expect(worker.messages).toEqual([]);
      expect(events).toEqual([]);

      worker.onmessage!({ data: { type: "business" } } as MessageEvent<unknown>);
      expect(events).toEqual([{ type: "business" }]);
      expect(handle.post({ type: "ping" })).toBeTrue();
      expect(worker.messages).toEqual([{ type: "ping" }]);
      expect(worker.terminated).toBeFalse();
      expect(scope.fatalErrors).toEqual([]);
    } finally {
      scope.restore();
      await handle.terminate();
    }
  });

  test("Worker 日志批次转投 DiskIO FIFO 后 ACK；旧代际迟到批次只 ACK 回原实例；ACK 被拒不撤销实例", async () => {
    const restoreDiskWorker: () => void = installFakeDiskIOWorker();
    try {
      initDiskIO();
    } catch (error: unknown) {
      restoreDiskWorker();
      throw error;
    }
    const diskWorker: FakeDiskIOWorker = FakeDiskIOWorker.instances[0]!;
    const scope: FakeWorkerScope = installFakeWorkerScope();
    const events: unknown[] = [];
    let giveUps: number = 0;
    const handle: SupervisedWorkerHandle<{ type: "restore" }> = superviseWorker<{ type: "restore" }, unknown>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onEvent: (event: unknown): void => {
        events.push(event);
      },
      onRespawn: (post: (message: { type: "restore" }) => boolean): void => {
        post({ type: "restore" });
      },
      onGiveUp: (): void => {
        giveUps++;
      },
    });
    const first: LogMessage = logMessage("first worker failure", 11);
    const second: LogMessage = logMessage("second worker failure", 12);

    try {
      handle.init();
      const original: FakeWorker = latestFakeWorker();

      // DiskIO 尚未可写：两条日志都由主线程 FIFO 接管，ACK 立即回给来源实例。
      original.onmessage!(logBatchEvent(7, [first, second]));
      expect(original.messages).toEqual([{ __logBatchAccepted: 7 }]);
      expect(diskIORuntime.diagnosticQueue.size).toBe(2);
      expect(events).toEqual([]);

      const loaded: Promise<unknown> = loadPersistedData(1_000);
      emitSuccessfulDiskIOLoad(diskWorker);
      await loaded;
      expect(lastDiskIOMessage(diskWorker, "diagnosticBatch").messages).toEqual([
        { type: "log", ...first },
        { type: "log", ...second },
      ]);

      original.onerror!({ message: "boom" } as ErrorEvent);
      const replacement: FakeWorker = latestFakeWorker();
      expect(replacement).not.toBe(original);
      const queuedBeforeLateBatch: number = diskIORuntime.diagnosticQueue.size;
      original.onmessage!(logBatchEvent(8, [logMessage("last words", 13)]));
      expect(diskIORuntime.diagnosticQueue.size).toBe(queuedBeforeLateBatch + 1);
      expect(original.messages).toEqual([{ __logBatchAccepted: 7 }, { __logBatchAccepted: 8 }]);
      expect(replacement.messages).toEqual([{ type: "restore" }]);

      replacement.postError = new Error("ack rejected");
      const queuedBeforeRejectedAck: number = diskIORuntime.diagnosticQueue.size;
      replacement.onmessage!(logBatchEvent(1, [logMessage("replacement failure", 14)]));
      // 本批一条，加上 ACK 投递失败时主线程 logger.error 自己入队的一条。
      expect(diskIORuntime.diagnosticQueue.size).toBe(queuedBeforeRejectedAck + 2);
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker postMessage failed:",
        expect.objectContaining({ message: "ack rejected" })
      );
      expect(replacement.terminated).toBeFalse();
      expect(giveUps).toBe(0);
      expect(scope.fatalErrors).toEqual([]);

      replacement.postError = null;
      expect(handle.post({ type: "restore" })).toBeTrue();
      expect(replacement.messages).toEqual([{ type: "restore" }, { type: "restore" }]);
      expect(events).toEqual([]);
    } finally {
      scope.restore();
      await handle.terminate();
      await terminateDiskIO();
      restoreDiskWorker();
    }
  });

  test("失败实例 terminate 同步抛出时只记日志，onGiveUp 与 fatal 照常执行", async () => {
    const scope: FakeWorkerScope = installFakeWorkerScope();
    let giveUps: number = 0;
    const handle: SupervisedWorkerHandle<{ type: "ping" }> = superviseWorker<{ type: "ping" }>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onGiveUp: (): void => {
        giveUps++;
      },
    });

    try {
      handle.init();
      const worker: FakeWorker = latestFakeWorker();
      worker.postError = new Error("post rejected");
      worker.terminateFailure = { value: new Error("terminate exploded") };

      expect(handle.post({ type: "ping" })).toBeFalse();
      expect(worker.terminated).toBeTrue();
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker termination after failure rejected:",
        expect.objectContaining({ message: "terminate exploded" })
      );
      expect(giveUps).toBe(1);
      expect(scope.fatalErrors).toHaveLength(1);
      expect(scope.fatalErrors[0]?.message).toBe("fake Worker synchronous message delivery was rejected.");

      // 实例已撤销，对外 terminate 不会再碰那个仍会抛错的替身。
      await expect(handle.terminate()).resolves.toBeUndefined();
      expect(handle.post({ type: "ping" })).toBeFalse();
    } finally {
      scope.restore();
      await handle.terminate();
    }
  });

  test("onGiveUp 抛出时只记日志，耗尽重启预算的 fatal 仍然送达", async () => {
    const scope: FakeWorkerScope = installFakeWorkerScope();
    let respawns: number = 0;
    const handle: SupervisedWorkerHandle<{ type: "ping" }> = superviseWorker<{ type: "ping" }>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onRespawn: (): void => {
        respawns++;
      },
      onGiveUp: (): void => {
        throw new Error("cleanup exploded");
      },
    });

    try {
      handle.init();
      for (let restart: number = 0; restart < WORKER_MAX_RESTARTS; restart++) {
        latestFakeWorker().onerror!({ message: `boom ${restart}` } as ErrorEvent);
      }
      expect(respawns).toBe(WORKER_MAX_RESTARTS);
      expect(FakeWorker.instances).toHaveLength(WORKER_MAX_RESTARTS + 1);
      expect(scope.fatalErrors).toEqual([]);

      const last: FakeWorker = latestFakeWorker();
      expect(() => last.onerror!({ message: "final boom" } as ErrorEvent)).not.toThrow();
      expect(FakeWorker.instances).toHaveLength(WORKER_MAX_RESTARTS + 1);
      expect(last.terminated).toBeTrue();
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker unavailable cleanup failed:",
        expect.objectContaining({ message: "cleanup exploded" })
      );
      expect(scope.fatalErrors).toHaveLength(1);
      expect(scope.fatalErrors[0]?.message).toBe(
        `fake Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
        `${WORKER_RESTART_WINDOW_MS / 1000}s; test feature unavailable`
      );
      expect(handle.post({ type: "ping" })).toBeFalse();
    } finally {
      scope.restore();
      await handle.terminate();
    }
  });

  test("替换 Worker 构造失败时撤销实例并永久不可用：Error 原样上报，非 Error 包装为带 cause 的 Error", async () => {
    const scope: FakeWorkerScope = installFakeWorkerScope();
    const constructionError: Error = new Error("construction exploded");
    const thrownValues: readonly unknown[] = [constructionError, "construction refused"];
    const handles: SupervisedWorkerHandle<{ type: "ping" }>[] = [];
    let respawns: number = 0;
    let giveUps: number = 0;

    try {
      for (const thrown of thrownValues) {
        const handle: SupervisedWorkerHandle<{ type: "ping" }> = superviseWorker<{ type: "ping" }>({
          url: "fake-worker.ts",
          label: "fake Worker",
          giveUpConsequence: "test feature unavailable",
          onRespawn: (): void => {
            respawns++;
          },
          onGiveUp: (): void => {
            giveUps++;
          },
        });
        handles.push(handle);
        handle.init();
        const crashed: FakeWorker = latestFakeWorker();
        const constructedBefore: number = FakeWorker.instances.length;
        FakeWorker.nextConstructFailure = { value: thrown };

        expect(() => crashed.onerror!({ message: "boom" } as ErrorEvent)).not.toThrow();
        expect(FakeWorker.instances).toHaveLength(constructedBefore);
        expect(crashed.terminated).toBeTrue();
        expect(handle.post({ type: "ping" })).toBeFalse();
        expect(crashed.messages).toEqual([]);
      }

      expect(respawns).toBe(0);
      expect(giveUps).toBe(2);
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker replacement construction failed:",
        expect.objectContaining({ message: "construction exploded" })
      );
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker replacement construction failed:",
        "construction refused"
      );
      expect(scope.fatalErrors).toHaveLength(2);
      expect(scope.fatalErrors[0]).toBe(constructionError);
      const wrapped: Error | undefined = scope.fatalErrors[1];
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped?.message).toBe("fake Worker replacement construction failed.");
      expect(wrapped?.cause).toBe("construction refused");
    } finally {
      scope.restore();
      for (const handle of handles) await handle.terminate();
    }
  });

  test("onRespawn 同步抛出时撤销新实例并永久不可用，之后残留的重放 post 一律拒绝", async () => {
    const scope: FakeWorkerScope = installFakeWorkerScope();
    const replayObject: { readonly code: string } = { code: "replay-broken" };
    const replayError: Error = new Error("replay exploded");
    const thrownValues: readonly unknown[] = [replayObject, replayError];
    const handles: SupervisedWorkerHandle<{ type: "restore" }>[] = [];
    const replayPosts: ((message: { type: "restore" }) => boolean)[] = [];
    const replayResults: boolean[] = [];
    let giveUps: number = 0;

    try {
      for (const [index, thrown] of thrownValues.entries()) {
        const handle: SupervisedWorkerHandle<{ type: "restore" }> = superviseWorker<{ type: "restore" }>({
          url: "fake-worker.ts",
          label: "fake Worker",
          giveUpConsequence: "test feature unavailable",
          onRespawn: (post: (message: { type: "restore" }) => boolean): void => {
            replayPosts.push(post);
            replayResults.push(post({ type: "restore" }));
            throw thrown;
          },
          onGiveUp: (): void => {
            giveUps++;
          },
        });
        handles.push(handle);
        handle.init();
        const crashed: FakeWorker = latestFakeWorker();

        expect(() => crashed.onerror!({ message: "boom" } as ErrorEvent)).not.toThrow();
        const replacement: FakeWorker = latestFakeWorker();
        expect(replacement).not.toBe(crashed);
        expect(replayResults[index]).toBeTrue();
        expect(replacement.messages).toEqual([{ type: "restore" }]);
        expect(replacement.terminated).toBeTrue();
        // 崩溃实例已由 Bun 自行终止，监督方只撤销替换出来的新实例。
        expect(crashed.terminated).toBeFalse();

        expect(replayPosts[index]!({ type: "restore" })).toBeFalse();
        expect(replacement.messages).toEqual([{ type: "restore" }]);
        expect(handle.post({ type: "restore" })).toBeFalse();
      }

      expect(giveUps).toBe(2);
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker state replay failed:",
        { code: "replay-broken" }
      );
      expect(scope.consoleError).toHaveBeenCalledWith(
        "fake Worker state replay failed:",
        expect.objectContaining({ message: "replay exploded" })
      );
      expect(scope.fatalErrors).toHaveLength(2);
      const wrapped: Error | undefined = scope.fatalErrors[0];
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped?.message).toBe("fake Worker state replay failed.");
      expect(wrapped?.cause).toBe(replayObject);
      expect(scope.fatalErrors[1]).toBe(replayError);
    } finally {
      scope.restore();
      for (const handle of handles) await handle.terminate();
    }
  });

  test("对外 terminate 同步抛出时 reject：Error 原样，非 Error 归一为固定 Error，句柄状态照常复位", async () => {
    const scope: FakeWorkerScope = installFakeWorkerScope();
    const terminateError: Error = new Error("terminate exploded");
    const signals: AbortSignal[] = [];
    const handle: SupervisedWorkerHandle<{ type: "ping" }> = superviseWorker<{ type: "ping" }, string>({
      url: "fake-worker.ts",
      label: "fake Worker",
      giveUpConsequence: "test feature unavailable",
      onEvent: (_event: string, context: SupervisedWorkerEventContext<{ type: "ping" }>): void => {
        signals.push(context.signal);
      },
    });

    try {
      handle.init();
      const first: FakeWorker = latestFakeWorker();
      first.onmessage!({ data: "event" } as MessageEvent<unknown>);
      expect(signals[0]?.aborted).toBeFalse();
      first.terminateFailure = { value: terminateError };

      await expect(handle.terminate()).rejects.toBe(terminateError);
      expect(first.terminated).toBeTrue();
      expect(signals[0]?.aborted).toBeTrue();
      expect(handle.post({ type: "ping" })).toBeFalse();
      await expect(handle.terminate()).resolves.toBeUndefined();

      // initialized 已复位：再次 init 会建出新实例，而不是被幂等守卫挡住。
      handle.init();
      const second: FakeWorker = latestFakeWorker();
      expect(second).not.toBe(first);
      expect(handle.post({ type: "ping" })).toBeTrue();
      expect(second.messages).toEqual([{ type: "ping" }]);
      second.terminateFailure = { value: "terminate refused" };

      let rejection: unknown = null;
      try {
        await handle.terminate();
      } catch (error: unknown) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe("Worker termination failed.");
      expect((rejection as Error).cause).toBe("terminate refused");
      expect(second.terminated).toBeTrue();
      expect(handle.post({ type: "ping" })).toBeFalse();
      expect(scope.fatalErrors).toEqual([]);
    } finally {
      scope.restore();
      await handle.terminate();
    }
  });
});
