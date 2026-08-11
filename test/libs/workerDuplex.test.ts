import { afterEach, describe, expect, test } from "bun:test";
import { workerDuplexWaiters } from "../../packages/cache/perThread/workerDuplex";
import {
  handleWorkerDuplexResponse,
  initializeWorkerDuplex,
  requestMainThread,
  resetWorkerDuplex,
} from "../../packages/libs/workerDuplex";
import { superviseDuplexWorker } from "../../packages/infra/supervisedDuplexWorker";
import type { WorkerDuplexOutbound } from "../../packages/types/workerDuplex";

interface TestRequest {
  readonly value: string;
}

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  readonly transfers: (Bun.Transferable[] | undefined)[] = [];

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: unknown, transfer?: Bun.Transferable[]): void {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {}
}

afterEach((): void => {
  resetWorkerDuplex("test cleanup");
  FakeWorker.instances.length = 0;
});

describe("Worker 双工能力边界", () => {
  test("Worker 先登记 waiter 再 post，并传播成功、错误和单请求取消", async () => {
    const outbound: WorkerDuplexOutbound<TestRequest>[] = [];
    const transfers: (Bun.Transferable[] | undefined)[] = [];
    initializeWorkerDuplex<TestRequest>((
      message: WorkerDuplexOutbound<TestRequest>,
      transfer?: Bun.Transferable[]
    ): void => {
      outbound.push(message);
      transfers.push(transfer);
    });

    const requestBuffer: ArrayBuffer = new ArrayBuffer(4);
    const succeeded: Promise<number> = requestMainThread<TestRequest, number>(
      { value: "ok" },
      undefined,
      [requestBuffer]
    );
    const request = outbound[0];
    expect(request?.__duplex).toBe("request");
    if (request?.__duplex !== "request") throw new Error("request envelope missing");
    expect(workerDuplexWaiters.has(request.requestId)).toBeTrue();
    expect(transfers[0]).toEqual([requestBuffer]);
    handleWorkerDuplexResponse({
      __duplex: "response",
      requestId: request.requestId,
      ok: true,
      value: 42,
      error: undefined,
    });
    await expect(succeeded).resolves.toBe(42);

    const controller: AbortController = new AbortController();
    const cancelled: Promise<number> = requestMainThread<TestRequest, number>(
      { value: "cancel" },
      controller.signal
    );
    const cancelledRequest = outbound[1];
    if (cancelledRequest?.__duplex !== "request") {
      throw new Error("cancelled request envelope missing");
    }
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(outbound[2]).toEqual({
      __duplex: "cancel",
      requestId: cancelledRequest.requestId,
    });
    handleWorkerDuplexResponse({
      __duplex: "response",
      requestId: cancelledRequest.requestId,
      ok: true,
      value: 99,
      error: undefined,
    });
    expect(workerDuplexWaiters.size).toBe(0);
  });

  test("主线程只回投当前代际；取消或 Worker 重建会中止能力请求", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    let pendingResolve!: (value: unknown) => void;
    let lastSignal: AbortSignal | undefined;
    const pending: Promise<unknown> = new Promise<unknown>((resolve: (value: unknown) => void): void => {
      pendingResolve = resolve;
    });
    const handle = superviseDuplexWorker<{ type: "business" }, { type: "event" }, TestRequest>({
      url: "fake-duplex-worker.ts",
      label: "fake duplex Worker",
      giveUpConsequence: "test unavailable",
      handleRequest: (request: TestRequest, signal: AbortSignal): Promise<unknown> => {
        lastSignal = signal;
        if (request.value === "pending") return pending;
        if (request.value === "bytes") return Promise.resolve(new Uint8Array([1, 2, 3]));
        return Promise.resolve(request.value);
      },
      responseTransfer: (_request: TestRequest, value: unknown): Bun.Transferable[] | undefined =>
        value instanceof Uint8Array && value.buffer instanceof ArrayBuffer
          ? [value.buffer]
          : undefined,
    });

    try {
      handle.init();
      const first: FakeWorker = FakeWorker.instances[0]!;
      first.onmessage!({
        data: { __duplex: "request", requestId: 1, request: { value: "ok" } },
      } as MessageEvent<unknown>);
      await Promise.resolve();
      expect(first.messages).toContainEqual({
        __duplex: "response",
        requestId: 1,
        ok: true,
        value: "ok",
        error: undefined,
      });

      first.onmessage!({
        data: { __duplex: "request", requestId: 3, request: { value: "bytes" } },
      } as MessageEvent<unknown>);
      await Promise.resolve();
      const byteResponseIndex: number = first.messages.findIndex((message: unknown): boolean =>
        typeof message === "object" && message !== null &&
        "requestId" in message && message.requestId === 3
      );
      expect(byteResponseIndex).toBeGreaterThanOrEqual(0);
      const byteResponse = first.messages[byteResponseIndex] as { value: Uint8Array };
      const responseBuffer: ArrayBufferLike = byteResponse.value.buffer;
      expect(responseBuffer).toBeInstanceOf(ArrayBuffer);
      if (!(responseBuffer instanceof ArrayBuffer)) throw new Error("response buffer is not transferable");
      expect(first.transfers[byteResponseIndex]).toEqual([responseBuffer]);

      first.onmessage!({
        data: { __duplex: "request", requestId: 2, request: { value: "pending" } },
      } as MessageEvent<unknown>);
      expect(lastSignal?.aborted).toBeFalse();
      first.onmessage!({
        data: { __duplex: "cancel", requestId: 2 },
      } as MessageEvent<unknown>);
      expect(lastSignal?.aborted).toBeTrue();
      pendingResolve("late");
      await Promise.resolve();
      expect(first.messages).not.toContainEqual(expect.objectContaining({ requestId: 2 }));

      let generationResolve!: (value: unknown) => void;
      const generationPending: Promise<unknown> = new Promise<unknown>(
        (resolve: (value: unknown) => void): void => { generationResolve = resolve; }
      );
      let generationSignal: AbortSignal | undefined;
      const generationHandle = superviseDuplexWorker<
        { type: "business" },
        { type: "event" },
        TestRequest
      >({
        url: "generation-worker.ts",
        label: "generation Worker",
        giveUpConsequence: "test unavailable",
        handleRequest: (_request: TestRequest, signal: AbortSignal): Promise<unknown> => {
          generationSignal = signal;
          return generationPending;
        },
      });
      generationHandle.init();
      const generationWorker: FakeWorker = FakeWorker.instances[1]!;
      generationWorker.onmessage!({
        data: { __duplex: "request", requestId: 1, request: { value: "pending" } },
      } as MessageEvent<unknown>);
      generationWorker.onerror!({ message: "boom" } as ErrorEvent);
      expect(generationSignal?.aborted).toBeTrue();
      generationResolve("late generation");
      await Promise.resolve();
      expect(generationWorker.messages).toHaveLength(0);
      expect(FakeWorker.instances[2]!.messages).toHaveLength(0);
      await generationHandle.terminate();
    } finally {
      await handle.terminate();
      globalThis.Worker = originalWorker;
    }
  });

  test("主线程普通错误不把可能含 token 的 message 送进 Worker", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const handle = superviseDuplexWorker<{ type: "business" }, { type: "event" }, TestRequest>({
      url: "safe-error-worker.ts",
      label: "safe error Worker",
      giveUpConsequence: "test unavailable",
      handleRequest: (): Promise<never> => Promise.reject(
        new Error("fetch https://api.telegram.org/bot123:secret/getFile failed")
      ),
    });

    try {
      handle.init();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      worker.onmessage!({
        data: { __duplex: "request", requestId: 1, request: { value: "fail" } },
      } as MessageEvent<unknown>);
      await Promise.resolve();
      const serialized: string = JSON.stringify(worker.messages);
      expect(serialized).toContain("Main-thread capability request failed.");
      expect(serialized).not.toContain("123:secret");
      expect(serialized).not.toContain("api.telegram.org");
    } finally {
      await handle.terminate();
      globalThis.Worker = originalWorker;
    }
  });

  test("响应 transfer 选择失败时回投安全错误，不悬挂 Worker waiter", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const handle = superviseDuplexWorker<
      { type: "business" },
      { type: "event" },
      TestRequest
    >({
      url: "transfer-error-worker.ts",
      label: "transfer error Worker",
      giveUpConsequence: "test unavailable",
      handleRequest: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array([1])),
      responseTransfer: (): Bun.Transferable[] => {
        throw new Error("sensitive transfer detail");
      },
    });

    try {
      handle.init();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      worker.onmessage!({
        data: { __duplex: "request", requestId: 9, request: { value: "bytes" } },
      } as MessageEvent<unknown>);
      await Promise.resolve();

      expect(worker.messages).toContainEqual({
        __duplex: "response",
        requestId: 9,
        ok: false,
        value: undefined,
        error: {
          name: "Error",
          message: "Main-thread capability response transfer failed.",
          telegramErrorCode: undefined,
          telegramDescription: undefined,
        },
      });
      expect(JSON.stringify(worker.messages)).not.toContain("sensitive transfer detail");
    } finally {
      await handle.terminate();
      globalThis.Worker = originalWorker;
    }
  });
});
