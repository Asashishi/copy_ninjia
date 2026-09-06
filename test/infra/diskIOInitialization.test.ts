import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  AiMemoryPersistedReply,
  DiskIORecoveryTransport,
  DiskIOReply,
  LuckDrawDiskMessage,
  VerificationPersistedReply,
} from "../../packages/types";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { onMidnightMaintenance } from "../../packages/infra/diskIO/observers";
import {
  DEFAULT_MAX_PENDING_BUSINESS_MESSAGES,
  LOAD_TIMEOUT_MS,
} from "../../packages/consts/diskIO/common";
import {
  emitSuccessfulDiskIOLoad as emitSuccessfulLoad,
  FakeDiskIOWorker as FakeWorker,
  TEST_LUCK_RECEIPT_SECRET as luckReceiptSecret,
} from "../helpers/diskIOWorkerHarness";

const diskIO = await import("../../packages/infra/diskIO");
const { superviseWorker } = await import("../../packages/infra/supervisedWorker");

const luckDraw: LuckDrawDiskMessage = {
  type: "luckDraw",
  day: "2026-07-19",
  key: "42",
  label: "大吉",
  fortunePercent: 99,
};
function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | undefined;
  const promise: Promise<void> = new Promise<void>((done: () => void): void => {
    resolve = done;
  });
  return { promise, resolve: (): void => resolve?.() };
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
});

describe("explicit Worker initialization", () => {
  test("午夜通知只路由当前 Worker，旧实例和终止后的通知无效", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    const count: number = diskIORuntime.midnightMaintenanceListeners.length;
    const days: string[] = [];
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      onMidnightMaintenance((reply): void => { days.push(reply.day); });
      diskIO.initDiskIO();
      const first: FakeWorker = FakeWorker.instances[0]!;
      const event = { data: { type: "midnightMaintenance", day: "2026-09-07" } } as MessageEvent<DiskIOReply>;
      first.onmessage!(event);
      expect(days).toEqual(["2026-09-07"]);
      await diskIO.terminateDiskIO();
      first.onmessage!(event);
      diskIO.initDiskIO();
      first.onmessage!(event);
      expect(days).toEqual(["2026-09-07"]);
      FakeWorker.instances[1]!.onmessage!(event);
      expect(days).toEqual(["2026-09-07", "2026-09-07"]);
    } finally {
      await diskIO.terminateDiskIO();
      diskIORuntime.midnightMaintenanceListeners.length = count;
      globalThis.Worker = originalWorker;
    }
  });

  test("全量恢复采用三十秒读取预算和四万五千条待写上限", () => {
    expect(LOAD_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_MAX_PENDING_BUSINESS_MESSAGES).toBe(45_000);
    expect(diskIORuntime.runtimeRecoveryTimeoutMs).toBe(LOAD_TIMEOUT_MS);
    expect(diskIORuntime.maxPendingBusinessMessages).toBe(
      DEFAULT_MAX_PENDING_BUSINESS_MESSAGES
    );
  });

  test("恢复监听器按显式优先级稳定排序，并拒绝重复 owner", () => {
    const originalRegistrations = [...diskIORuntime.respawnListeners];
    const listener = (): boolean => true;
    try {
      diskIO.onDiskIORespawn("later", 200, listener);
      diskIO.onDiskIORespawn("first", 100, listener);
      diskIO.onDiskIORespawn("same-z", 200, listener);
      diskIO.onDiskIORespawn("same-a", 200, listener);

      const addedOwners: string[] = diskIORuntime.respawnListeners
        .map((registration) => registration.owner)
        .filter((owner: string): boolean => ["first", "later", "same-a", "same-z"].includes(owner));
      expect(addedOwners).toEqual([
        "first",
        "later",
        "same-a",
        "same-z",
      ]);
      expect(() => diskIO.onDiskIORespawn("later", 300, listener)).toThrow("already registered");
      expect(() => diskIO.onDiskIORespawn("invalid", Number.NaN, listener)).toThrow("safe integer");
    } finally {
      diskIORuntime.respawnListeners.splice(
        0,
        diskIORuntime.respawnListeners.length,
        ...originalRegistrations
      );
    }
  });

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
    const respawnListenerCount: number = diskIORuntime.respawnListeners.length;
    try {
      expect(FakeWorker.instances).toHaveLength(0);
      diskIO.initDiskIO({ onFatal: (fatal) => { fatalErrors.push(fatal); } });
      diskIO.initDiskIO();
      expect(FakeWorker.instances).toHaveLength(1);
      const first: FakeWorker = FakeWorker.instances[0]!;

      const loadedPromise = diskIO.loadPersistedData(1_000);
      expect(first.messages.at(-1)).toEqual(expect.objectContaining({ type: "load" }));
      first.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map([[1, "memory"]]),
        stickerCatalogs: new Map([["pack", "catalog"]]),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
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

      // 带回执的出口把领域名一并带出，且只带**本次请求**回执里的那一份：
      // 上一次失败留下的 aiMemory 不得出现在这一次的诊断里，否则 /block 会
      // 把运维引向一个跟本次失败毫无关系的文件。
      const outcomePromise = diskIO.flushDiskIODomainOutcome("blocklist", 1_000);
      const outcomeFlush = first.messages.at(-1)!;
      expect(outcomeFlush.type).toBe("flush");
      const outcomeReply: DiskIOReply = {
        type: "flushFailed",
        flushedId: outcomeFlush.type === "flush" ? outcomeFlush.flushId : -1,
        failedDomains: ["blocklist", "joinLog"],
      };
      first.onmessage!({ data: outcomeReply } as MessageEvent<DiskIOReply>);
      expect(await outcomePromise).toEqual({
        result: "failed",
        failedDomains: ["blocklist", "joinLog"],
      });

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
      diskIO.onDiskIORespawn("test mirror", 1_000, (transport: DiskIORecoveryTransport): boolean => {
        respawns++;
        return transport.post(luckDraw);
      });
      first.onerror!({ message: "boom" } as ErrorEvent);
      expect(FakeWorker.instances).toHaveLength(2);
      const second: FakeWorker = FakeWorker.instances[1]!;
      expect(respawns).toBe(0);
      expect(second.messages).toEqual([expect.objectContaining({ type: "load" })]);

      // load 完整成功前镜像不重放；成功回执后才进入 writable。
      second.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret,
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
      } } as MessageEvent<DiskIOReply>);
      expect(respawns).toBe(1);
      expect(second.messages).toEqual([expect.objectContaining({ type: "load" }), luckDraw]);

      first.onmessage!({ data: { ...ack, revision: 99 } } as MessageEvent<DiskIOReply>);
      expect(persisted).toEqual([ack]);

      // 运行时恢复失败时不得重放、flush 或继续写入部分缓存。
      second.onerror!({ message: "boom again" } as ErrorEvent);
      const third: FakeWorker = FakeWorker.instances[2]!;
      diskIO.postDiskIO(luckDraw);
      expect(third.messages).toEqual([expect.objectContaining({ type: "load" })]);
      third.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: null,
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
        error: "verification file is corrupt",
      } } as MessageEvent<DiskIOReply>);
      await Promise.resolve();
      expect(respawns).toBe(1);
      expect(third.messages).toEqual([expect.objectContaining({ type: "load" })]);
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
      diskIORuntime.respawnListeners.length = respawnListenerCount;
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("异步镜像完成前保持不可写，完成后先重放镜像再排空业务缓冲", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const gate = deferredVoid();
    const respawnListenerCount: number = diskIORuntime.respawnListeners.length;
    const bufferedDraw: LuckDrawDiskMessage = { ...luckDraw, key: "buffered" };
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;
      await Bun.sleep(0);
      worker.messages.length = 0;

      diskIO.onDiskIORespawn("delayed mirror", 1_000, async (
        transport: DiskIORecoveryTransport
      ): Promise<boolean> => {
        await gate.promise;
        return transport.post(luckDraw);
      });
      diskIORuntime.writable = false;
      diskIORuntime.runtimeRecoveryWorker = worker as unknown as Worker;
      expect(diskIO.postDiskIO(bufferedDraw)).toBeTrue();
      emitSuccessfulLoad(worker);
      await Promise.resolve();

      expect(diskIORuntime.writable).toBeFalse();
      expect(worker.messages).toEqual([]);
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(1);
      expect(await diskIO.flushDiskIO(10)).toBe("failed");

      gate.resolve();
      await Bun.sleep(0);
      // 镜像先于业务缓冲；缓冲那一批被一对重放标记框住，好让 Worker 知道这段
      // 区间内的写失败没有任何后续 flush 会去问（见 types/diskIO.ts 的
      // RecoveryReplayRequest）。镜像走 scoped transport，不在区间内。
      expect(worker.messages).toEqual([
        luckDraw,
        { type: "recoveryReplay", active: true },
        bufferedDraw,
        { type: "recoveryReplay", active: false },
      ]);
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(0);
      expect(diskIORuntime.writable).toBeTrue();
    } finally {
      diskIORuntime.respawnListeners.length = respawnListenerCount;
      gate.resolve();
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("镜像等待期间再次崩溃时，旧代际迟到成功不能激活或写入新实例", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    const oldGate = deferredVoid();
    const respawnListenerCount: number = diskIORuntime.respawnListeners.length;
    let invocations: number = 0;
    const currentDraw: LuckDrawDiskMessage = { ...luckDraw, key: "current-generation" };
    const staleDraw: LuckDrawDiskMessage = { ...luckDraw, key: "stale-generation" };
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error): void => { fatalErrors.push(fatal); } });
      const first: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(first);
      await loadedPromise;
      await Bun.sleep(0);
      diskIO.onDiskIORespawn("generation mirror", 1_000, async (
        transport: DiskIORecoveryTransport
      ): Promise<boolean> => {
        invocations++;
        if (invocations === 1) {
          await oldGate.promise;
          return transport.post(staleDraw);
        }
        return transport.post(currentDraw);
      });

      first.onerror!({ message: "first runtime crash" } as ErrorEvent);
      const staleRecovery: FakeWorker = FakeWorker.instances[1]!;
      emitSuccessfulLoad(staleRecovery);
      await Promise.resolve();
      expect(invocations).toBe(1);

      staleRecovery.onerror!({ message: "recovery crashed during mirror" } as ErrorEvent);
      const currentRecovery: FakeWorker = FakeWorker.instances[2]!;
      emitSuccessfulLoad(currentRecovery);
      await Bun.sleep(0);
      expect(invocations).toBe(2);
      expect(currentRecovery.messages).toEqual([
        expect.objectContaining({ type: "load" }),
        currentDraw,
      ]);
      expect(diskIORuntime.writable).toBeTrue();

      oldGate.resolve();
      await Bun.sleep(0);
      expect(staleRecovery.messages).toEqual([expect.objectContaining({ type: "load" })]);
      expect(currentRecovery.messages).toEqual([
        expect.objectContaining({ type: "load" }),
        currentDraw,
      ]);
      expect(diskIORuntime.worker).toBe(currentRecovery as unknown as Worker);
      expect(diskIORuntime.writable).toBeTrue();
      expect(fatalErrors).toHaveLength(0);
    } finally {
      diskIORuntime.respawnListeners.length = respawnListenerCount;
      oldGate.resolve();
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("镜像返回 false 或抛错都会 fail closed 并指出失败领域", async () => {
    const scenarios: readonly {
      owner: string;
      listener: (transport: DiskIORecoveryTransport) => boolean | Promise<boolean>;
      expected: string;
    }[] = [
      {
        owner: "false mirror",
        listener: (): boolean => false,
        expected: "reported failure",
      },
      {
        owner: "throwing mirror",
        listener: (): boolean => { throw new Error("synchronous replay failure"); },
        expected: "synchronous replay failure",
      },
      {
        owner: "rejecting mirror",
        listener: async (): Promise<never> => {
          throw new Error("asynchronous replay failure");
        },
        expected: "asynchronous replay failure",
      },
    ];
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const scenario of scenarios) {
        FakeWorker.instances.length = 0;
        const fatalErrors: Error[] = [];
        const respawnListenerCount: number = diskIORuntime.respawnListeners.length;
        try {
          diskIO.initDiskIO({ onFatal: (fatal: Error): void => { fatalErrors.push(fatal); } });
          const worker: FakeWorker = FakeWorker.instances[0]!;
          const loadedPromise = diskIO.loadPersistedData(1_000);
          emitSuccessfulLoad(worker);
          await loadedPromise;
          await Bun.sleep(0);
          diskIO.onDiskIORespawn(scenario.owner, 1_000, scenario.listener);
          diskIORuntime.writable = false;
          diskIORuntime.runtimeRecoveryWorker = worker as unknown as Worker;
          expect(diskIO.postDiskIO(luckDraw)).toBeTrue();

          emitSuccessfulLoad(worker);
          await Bun.sleep(0);

          expect(worker.terminated).toBeTrue();
          expect(diskIORuntime.writable).toBeFalse();
          expect(diskIORuntime.pendingBusinessMessages.size).toBe(1);
          expect(fatalErrors).toHaveLength(1);
          expect(fatalErrors[0]?.message).toContain(scenario.owner);
          expect(fatalErrors[0]?.message).toContain(scenario.expected);
        } finally {
          diskIORuntime.respawnListeners.length = respawnListenerCount;
          await diskIO.terminateDiskIO();
        }
      }
    } finally {
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("重放期间的写失败回执按 fatal 停机，不留下已确认却没落盘的事实", async () => {
    // 缓冲那一刻 recordJoinLog 就已经放行了该 update，此后没有任何 flush 会再问
    // 它写没写进去；Worker 只能靠这条回执把失败报上来，主线程据此停机，让
    // Telegram 从上一个确认点整段重投（见 infra/joinLog.ts）。
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error): void => { fatalErrors.push(fatal); } });
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;
      await Bun.sleep(0);

      worker.onmessage!({
        data: {
          type: "recoveryReplayFailed",
          domain: "joinLog",
          error: "Join log buffer reached its hard limit of 4096 entries.",
        },
      } as MessageEvent<DiskIOReply>);

      expect(worker.terminated).toBeTrue();
      expect(diskIORuntime.writable).toBeFalse();
      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("joinLog replay failed during recovery");
      expect(fatalErrors[0]?.message).toContain("hard limit");
    } finally {
      error.mockRestore();
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("scoped transport 投递被同步拒绝时不会继续后续镜像", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    const respawnListenerCount: number = diskIORuntime.respawnListeners.length;
    let laterMirrorRan: boolean = false;
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error): void => { fatalErrors.push(fatal); } });
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;
      await Bun.sleep(0);
      worker.rejectedTypes.add("luckDraw");
      diskIO.onDiskIORespawn("rejected mirror", 1_000, (
        transport: DiskIORecoveryTransport
      ): boolean => transport.post(luckDraw));
      diskIO.onDiskIORespawn("later mirror", 2_000, (): boolean => {
        laterMirrorRan = true;
        return true;
      });
      diskIORuntime.writable = false;
      diskIORuntime.runtimeRecoveryWorker = worker as unknown as Worker;

      emitSuccessfulLoad(worker);
      await Bun.sleep(0);

      expect(laterMirrorRan).toBeFalse();
      expect(worker.terminated).toBeTrue();
      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("rejected mirror");
    } finally {
      diskIORuntime.respawnListeners.length = respawnListenerCount;
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });
});
