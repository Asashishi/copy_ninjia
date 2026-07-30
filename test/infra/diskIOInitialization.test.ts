import { describe, expect, spyOn, test } from "bun:test";
import type {
  AiMemoryPersistedReply,
  DiskIOMessage,
  DiskIOReply,
  LuckDrawDiskMessage,
  VerificationPersistedReply,
} from "../../packages/types";
import { pendingLoad, pendingLuckSecrets } from "../../packages/cache/main/diskIO";

const diskIO = await import("../../packages/infra/diskIO");
const { superviseWorker } = await import("../../packages/libs/supervisedWorker");

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<DiskIOReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];
  readonly rejectedTypes = new Set<DiskIOMessage["type"]>();
  terminated: boolean = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: DiskIOMessage): void {
    if (this.rejectedTypes.has(message.type)) throw new Error(`rejected ${message.type}`);
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

const luckDraw: LuckDrawDiskMessage = {
  type: "luckDraw",
  day: "2026-07-19",
  key: "42",
  label: "大吉",
  fortunePercent: 99,
};
const luckReceiptSecret = {
  version: 1 as const,
  day: "2026-07-19",
  key: Buffer.alloc(32, 7).toString("base64url"),
};

describe("explicit Worker initialization", () => {
  test("拒绝非正有限恢复预算和非法待写容量，且不留下半初始化状态", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      expect(() => diskIO.initDiskIO({ runtimeRecoveryTimeoutMs: Number.NaN })).toThrow("positive finite");
      expect(() => diskIO.initDiskIO({ runtimeRecoveryTimeoutMs: 0 })).toThrow("positive finite");
      expect(() => diskIO.initDiskIO({ maxPendingBusinessMessages: 0 })).toThrow("positive safe integer");
      expect(() => diskIO.initDiskIO({ maxPendingBusinessMessages: 1.5 })).toThrow("positive safe integer");
      expect(diskIO.isDiskIOInitialized()).toBeFalse();
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("imports are inert; init, handshakes, stale guards, and respawn replay are deterministic", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    try {
      expect(FakeWorker.instances).toHaveLength(0);
      diskIO.initDiskIO({ onFatal: (fatal) => { fatalErrors.push(fatal); } });
      diskIO.initDiskIO();
      expect(FakeWorker.instances).toHaveLength(1);
      const first: FakeWorker = FakeWorker.instances[0]!;

      const loadedPromise = diskIO.loadPersistedData(1_000);
      expect(first.messages.at(-1)).toEqual({ type: "load" });
      first.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map([[1, "memory"]]),
        stickerCatalogs: new Map([["pack", "catalog"]]),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
      } } as MessageEvent<DiskIOReply>);
      expect(await loadedPromise).toMatchObject({
        aiMemories: new Map([[1, "memory"]]),
        stickerCatalogs: new Map([["pack", "catalog"]]),
        luckReceiptSecret,
      });

      const secretPromise = diskIO.ensureLuckReceiptSecret("2026-07-19", 1_000);
      const secretRequest = first.messages.at(-1)!;
      expect(secretRequest.type).toBe("ensureLuckSecret");
      first.onmessage!({ data: {
        type: "luckSecret",
        requestId: secretRequest.type === "ensureLuckSecret" ? secretRequest.requestId : -1,
        secret: luckReceiptSecret,
      } } as MessageEvent<DiskIOReply>);
      expect(await secretPromise).toEqual(luckReceiptSecret);

      const flushPromise = diskIO.flushDiskIO(1_000);
      const flush = first.messages.at(-1)!;
      expect(flush.type).toBe("flush");
      first.onmessage!({ data: { type: "flushed", flushedId: flush.type === "flush" ? flush.flushId : -1 } } as MessageEvent<DiskIOReply>);
      await flushPromise;

      const failedFlushPromise = diskIO.flushDiskIO(1_000);
      const failedFlush = first.messages.at(-1)!;
      expect(failedFlush.type).toBe("flush");
      // 回执按领域回报失败，让 /block 这类只关心自己那个领域的调用方不被
      // 无关领域误导（见 workers/diskIOWorker.ts 的 flushAll）。
      const failedReply: DiskIOReply = {
        type: "flushFailed",
        flushedId: failedFlush.type === "flush" ? failedFlush.flushId : -1,
        failedDomains: ["aiMemory"],
      };
      first.onmessage!({ data: failedReply } as MessageEvent<DiskIOReply>);
      expect(await failedFlushPromise).toBe("failed");

      const unrelatedDomainFlushPromise = diskIO.flushDiskIODomain("blocklist", 1_000);
      const unrelatedDomainFlush = first.messages.at(-1)!;
      expect(unrelatedDomainFlush.type).toBe("flush");
      const unrelatedDomainReply: DiskIOReply = {
        type: "flushFailed",
        flushedId: unrelatedDomainFlush.type === "flush" ? unrelatedDomainFlush.flushId : -1,
        failedDomains: ["aiMemory"],
      };
      first.onmessage!({ data: unrelatedDomainReply } as MessageEvent<DiskIOReply>);
      expect(await unrelatedDomainFlushPromise).toBe("flushed");

      const targetDomainFlushPromise = diskIO.flushDiskIODomain("blocklist", 1_000);
      const targetDomainFlush = first.messages.at(-1)!;
      expect(targetDomainFlush.type).toBe("flush");
      const targetDomainReply: DiskIOReply = {
        type: "flushFailed",
        flushedId: targetDomainFlush.type === "flush" ? targetDomainFlush.flushId : -1,
        failedDomains: ["blocklist"],
      };
      first.onmessage!({ data: targetDomainReply } as MessageEvent<DiskIOReply>);
      expect(await targetDomainFlushPromise).toBe("failed");

      const persisted: VerificationPersistedReply[] = [];
      diskIO.onVerificationPersisted((reply) => { persisted.push(reply); });
      const ack: VerificationPersistedReply = {
        type: "verificationPersisted",
        key: "-1001:42",
        generation: 1,
        revision: 2,
        deleted: true,
      };
      first.onmessage!({ data: ack } as MessageEvent<DiskIOReply>);
      expect(persisted).toEqual([ack]);

      const aiMemoryPersisted: AiMemoryPersistedReply[] = [];
      diskIO.onAiMemoryPersisted((reply) => { aiMemoryPersisted.push(reply); });
      const aiMemoryAck: AiMemoryPersistedReply = {
        type: "aiMemoryPersisted",
        chatId: -1001,
        revision: 3,
      };
      first.onmessage!({ data: aiMemoryAck } as MessageEvent<DiskIOReply>);
      expect(aiMemoryPersisted).toEqual([aiMemoryAck]);

      let respawns: number = 0;
      diskIO.onDiskIORespawn(() => {
        respawns++;
        diskIO.postDiskIO(luckDraw);
      });
      first.onerror!({ message: "boom" } as ErrorEvent);
      expect(FakeWorker.instances).toHaveLength(2);
      const second: FakeWorker = FakeWorker.instances[1]!;
      expect(respawns).toBe(0);
      expect(second.messages).toEqual([{ type: "load" }]);

      // load 完整成功前镜像不重放；成功回执后才进入 writable。
      second.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
      } } as MessageEvent<DiskIOReply>);
      expect(respawns).toBe(1);
      expect(second.messages).toEqual([{ type: "load" }, luckDraw]);

      first.onmessage!({ data: { ...ack, revision: 99 } } as MessageEvent<DiskIOReply>);
      expect(persisted).toEqual([ack]);

      // 运行时恢复失败时不得重放、flush 或继续写入部分缓存。
      second.onerror!({ message: "boom again" } as ErrorEvent);
      const third: FakeWorker = FakeWorker.instances[2]!;
      diskIO.postDiskIO(luckDraw);
      expect(third.messages).toEqual([{ type: "load" }]);
      third.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: null,
        verifications: new Map(),
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
        error: "verification file is corrupt",
      } } as MessageEvent<DiskIOReply>);
      await Promise.resolve();
      expect(respawns).toBe(1);
      expect(third.messages).toEqual([{ type: "load" }]);
      expect(third.terminated).toBe(true);
      expect(await diskIO.flushDiskIO(1_000)).toBe("failed");
      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("verification file is corrupt");

      let supervisedConstructed: number = FakeWorker.instances.length;
      const handle = superviseWorker({ url: "fake-worker.ts", label: "fake", giveUpConsequence: "none" });
      expect(FakeWorker.instances.length).toBe(supervisedConstructed);
      handle.init();
      supervisedConstructed++;
      handle.init();
      expect(FakeWorker.instances.length).toBe(supervisedConstructed);
      const supervised: FakeWorker = FakeWorker.instances.at(-1)!;
      await handle.terminate();
      expect(supervised.terminated).toBe(true);
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("终止 Worker 会立即拒绝在途运势密钥请求并清理其超时计时器", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      worker.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
      } } as MessageEvent<DiskIOReply>);
      await loadedPromise;

      const pendingSecret = diskIO.ensureLuckReceiptSecret("2026-07-20", 60_000)
        .then(() => null, (error: unknown) => error);
      await diskIO.terminateDiskIO();

      expect(await pendingSecret).toBeInstanceOf(Error);
      expect(worker.terminated).toBeTrue();
    } finally {
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("运行时 load 握手超时会终止不可用 Worker 并发出 fatal 信号", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    try {
      diskIO.initDiskIO({
        onFatal: (fatal) => { fatalErrors.push(fatal); },
        runtimeRecoveryTimeoutMs: 2,
      });
      const first: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      first.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
      } } as MessageEvent<DiskIOReply>);
      await loadedPromise;

      first.onerror!({ message: "runtime crash" } as ErrorEvent);
      const recovery: FakeWorker = FakeWorker.instances[1]!;
      expect(recovery.messages).toEqual([{ type: "load" }]);
      await Bun.sleep(10);

      expect(recovery.terminated).toBe(true);
      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("timed out");
      expect(await diskIO.flushDiskIO(10)).toBe("failed");
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("同步投递拒绝会立即清理请求等待项，业务写入则 fail closed", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    try {
      diskIO.initDiskIO({ onFatal: (fatal) => { fatalErrors.push(fatal); } });
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      worker.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        blockedUsers: new Map(),
        pendingBlockedRemovals: new Map(),
      } } as MessageEvent<DiskIOReply>);
      await loadedPromise;

      worker.rejectedTypes.add("ensureLuckSecret");
      await expect(diskIO.ensureLuckReceiptSecret("2026-07-21", 60_000))
        .rejects.toThrow("rejected the luck receipt secret request");
      expect(pendingLuckSecrets.size).toBe(0);

      worker.rejectedTypes.add("flush");
      await expect(diskIO.flushDiskIO(60_000)).resolves.toBe("failed");
      await expect(diskIO.flushDiskIODomain("blocklist", 60_000)).resolves.toBe("failed");

      worker.rejectedTypes.add("log");
      expect(diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["boom"] })).toBe(false);
      expect(fatalErrors).toHaveLength(0);

      worker.rejectedTypes.add("luckDraw");
      expect(diskIO.postDiskIO(luckDraw)).toBe(false);
      expect(fatalErrors).toHaveLength(1);
      expect(worker.terminated).toBe(true);
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("启动 load 同步拒绝时不遗留 timer 或 resolver", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      worker.rejectedTypes.add("load");

      await expect(diskIO.loadPersistedData(60_000)).rejects.toThrow("rejected the startup load request");
      expect(pendingLoad).toEqual({ resolve: null, reject: null, timer: null });
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("Worker 未初始化时领域 flush 不会复用旧回执误报成功", async () => {
    await diskIO.terminateDiskIO();
    expect(diskIO.lastFailedDiskIODomains()).toEqual([]);
    await expect(diskIO.flushDiskIODomain("blocklist", 1_000)).resolves.toBe("failed");
  });
});
