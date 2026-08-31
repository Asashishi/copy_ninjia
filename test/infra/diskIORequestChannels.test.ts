import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  DiskIOMessage,
  DiskIOReply,
  LuckAppendStalledReply,
  LuckDrawDiskMessage,
} from "../../packages/types";
import type {
  BlocklistIdPage,
  IdentityPolicyRawReadResult,
} from "../../packages/types/identityStorage";
import {
  blocklistIdPageReadRequests,
  diskIORuntime,
  identityPolicyReadRequests,
  joinLogReadRequests,
  pendingLoad,
  luckSecretRequests,
} from "../../packages/cache/main/diskIO";
import { DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES } from "../../packages/consts/diskIO/diagnostics";
import {
  acceptDiskIODiagnosticBatch,
  pauseDiskIODiagnosticChannel,
  resumeDiskIODiagnosticChannel,
} from "../../packages/infra/diskIO/diagnosticChannel";
import {
  emitSuccessfulDiskIOLoad as emitSuccessfulLoad,
  FakeDiskIOWorker as FakeWorker,
  TEST_LUCK_RECEIPT_SECRET as luckReceiptSecret,
} from "../helpers/diskIOWorkerHarness";

const diskIO = await import("../../packages/infra/diskIO");

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

describe("Disk I/O 请求通道、运行时恢复与诊断缓冲", () => {
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
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
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

  test("运势追加停摆诊断转交监听器，已被换掉的旧 Worker 报上来的不算数", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    const originalListeners = [...diskIORuntime.luckAppendStalledListeners];
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;

      const seen: LuckAppendStalledReply[] = [];
      diskIO.onLuckAppendStalled((reply: LuckAppendStalledReply): void => { seen.push(reply); });
      const stalled: LuckAppendStalledReply = {
        type: "luckAppendStalled",
        day: "2026-07-19",
        pendingEntries: 4,
        consecutiveFailures: 3,
        error: "ENOSPC: no space left on device",
      };
      worker.onmessage!({ data: stalled } as MessageEvent<DiskIOReply>);
      expect(seen).toEqual([stalled]);

      // 换掉当前 Worker 之后，旧实例的迟到诊断不得再进日志：那条已经不代表
      // 现役落盘线程的状态，会把运维引到一个其实已经不存在的故障上。
      await diskIO.terminateDiskIO();
      worker.onmessage!({ data: stalled } as MessageEvent<DiskIOReply>);
      expect(seen).toEqual([stalled]);
    } finally {
      await diskIO.terminateDiskIO();
      diskIORuntime.luckAppendStalledListeners.splice(
        0,
        diskIORuntime.luckAppendStalledListeners.length,
        ...originalListeners
      );
      globalThis.Worker = originalWorker;
    }
  });

  test("入群日志请求按 requestId 路由，终止时立即拒绝并清理等待表", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;

      const readPromise = diskIO.readJoinLog({
        chatId: -1001,
        since: 123,
        now: 789,
        timeoutMs: 1_000,
      });
      const request = worker.messages.at(-1)!;
      expect(request).toMatchObject({
        type: "readJoinLog",
        chatId: -1001,
        since: 123,
        now: 789,
      });
      worker.onmessage!({ data: {
        type: "joinLogRead",
        requestId: request.type === "readJoinLog" ? request.requestId : -1,
        records: [{ userId: 42, joinedAt: 456 }],
      } } as unknown as MessageEvent<DiskIOReply>);
      await expect(readPromise).resolves.toEqual([{ userId: 42, joinedAt: 456 }]);
      expect(joinLogReadRequests.pending.size).toBe(0);

      const pendingRead = diskIO.readJoinLog({
        chatId: -1001,
        since: 0,
        now: 789,
        timeoutMs: 60_000,
      }).then(() => null, (error: unknown) => error);
      expect(joinLogReadRequests.pending.size).toBe(1);
      await diskIO.terminateDiskIO();
      expect(await pendingRead).toBeInstanceOf(Error);
      expect(joinLogReadRequests.pending.size).toBe(0);
    } finally {
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("身份策略与黑名单分页请求完整接线，缺载荷和超时均清理等待表", async (): Promise<void> => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise: Promise<unknown> = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;

      const policiesPromise: Promise<IdentityPolicyRawReadResult> =
        diskIO.readIdentityPolicies([42, 43], 1_000);
      const policiesRequest: DiskIOMessage | undefined = worker.messages.at(-1);
      expect(policiesRequest).toMatchObject({
        type: "readIdentityPolicies",
        ids: [42, 43],
      });
      if (policiesRequest?.type !== "readIdentityPolicies") {
        throw new Error("missing identity policy request");
      }
      worker.onmessage!({ data: {
        type: "identityPoliciesRead",
        requestId: policiesRequest.requestId,
        whitelist: [[42, "{\"isCanUseBot\":true}"]],
        blocklist: [[43, "{\"reason\":\"spam\"}"]],
        temporaryWhitelist: [],
      } } as unknown as MessageEvent<DiskIOReply>);
      await expect(policiesPromise).resolves.toEqual({
        whitelist: [[42, "{\"isCanUseBot\":true}"]],
        blocklist: [[43, "{\"reason\":\"spam\"}"]],
        temporaryWhitelist: [],
      });
      expect(identityPolicyReadRequests.pending.size).toBe(0);

      const pagePromise: Promise<BlocklistIdPage> =
        diskIO.readBlocklistIdPage(43, 1_000);
      const pageRequest: DiskIOMessage | undefined = worker.messages.at(-1);
      expect(pageRequest).toMatchObject({
        type: "readBlocklistIdPage",
        afterId: 43,
      });
      if (pageRequest?.type !== "readBlocklistIdPage") {
        throw new Error("missing blocklist page request");
      }
      worker.onmessage!({ data: {
        type: "blocklistIdPageRead",
        requestId: pageRequest.requestId,
        page: { ids: [44, 45], nextCursor: 45, done: false },
      } } as unknown as MessageEvent<DiskIOReply>);
      await expect(pagePromise).resolves.toEqual({
        ids: [44, 45],
        nextCursor: 45,
        done: false,
      });
      expect(blocklistIdPageReadRequests.pending.size).toBe(0);

      const incompletePromise: Promise<IdentityPolicyRawReadResult> =
        diskIO.readIdentityPolicies([99], 1_000);
      const incompleteRequest: DiskIOMessage | undefined = worker.messages.at(-1);
      if (incompleteRequest?.type !== "readIdentityPolicies") {
        throw new Error("missing incomplete identity policy request");
      }
      worker.onmessage!({ data: {
        type: "identityPoliciesRead",
        requestId: incompleteRequest.requestId,
        whitelist: [],
      } } as unknown as MessageEvent<DiskIOReply>);
      await expect(incompletePromise).rejects.toThrow(
        "Disk I/O Worker returned no identity policy rows."
      );
      expect(identityPolicyReadRequests.pending.size).toBe(0);

      await expect(diskIO.readBlocklistIdPage(null, 1)).rejects.toThrow(
        "blocklist ID page read request timed out"
      );
      expect(blocklistIdPageReadRequests.pending.size).toBe(0);
    } finally {
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("运行时恢复 timer 覆盖永不结束的异步镜像并清空业务缓冲", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    const gate = deferredVoid();
    const respawnListenerCount: number = diskIORuntime.respawnListeners.length;
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
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
      } } as MessageEvent<DiskIOReply>);
      await loadedPromise;

      diskIO.onDiskIORespawn("hung mirror", 1_000, async (): Promise<boolean> => {
        await gate.promise;
        return true;
      });
      first.onerror!({ message: "runtime crash" } as ErrorEvent);
      const recovery: FakeWorker = FakeWorker.instances[1]!;
      expect(recovery.messages).toEqual([expect.objectContaining({ type: "load" })]);
      expect(diskIO.postDiskIO(luckDraw)).toBeTrue();
      emitSuccessfulLoad(recovery);
      await Promise.resolve();
      expect(diskIORuntime.writable).toBeFalse();
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(1);
      await Bun.sleep(10);

      expect(recovery.terminated).toBe(true);
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(0);
      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("timed out");
      expect(await diskIO.flushDiskIO(10)).toBe("failed");
    } finally {
      diskIORuntime.respawnListeners.length = respawnListenerCount;
      gate.resolve();
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
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        whitelistEntryCount: 0,
      } } as MessageEvent<DiskIOReply>);
      await loadedPromise;

      worker.rejectedTypes.add("ensureLuckSecret");
      await expect(diskIO.ensureLuckReceiptSecret("2026-07-21", 60_000))
        .rejects.toThrow("rejected the luck receipt secret request");
      expect(luckSecretRequests.pending.size).toBe(0);

      worker.rejectedTypes.add("flush");
      await expect(diskIO.flushDiskIO(60_000)).resolves.toBe("failed");
      await expect(diskIO.flushDiskIODomain("blocklist", 60_000)).resolves.toBe("failed");

      worker.rejectedTypes.add("diagnosticBatch");
      expect(diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["boom"] })).toBe(true);
      expect(diskIORuntime.diagnosticQueue.size).toBe(1);
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

  test("诊断同步拒收与 DiskIO 代际崩溃都保留原批，恢复后按 ACK 顺序继续排空", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    const registrations = [...diskIORuntime.respawnListeners];
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      diskIORuntime.respawnListeners.length = 0;
      diskIO.initDiskIO();
      const first: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(first);
      await loadedPromise;
      first.messages.length = 0;

      first.rejectedTypes.add("diagnosticBatch");
      expect(diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["first"] })).toBe(true);
      expect(diskIORuntime.diagnosticQueue.size).toBe(1);
      expect(diskIORuntime.diagnosticQueue.awaitingAcknowledgement).toBe(false);

      first.rejectedTypes.delete("diagnosticBatch");
      expect(diskIO.relayLogMessage({ timestamp: 2, level: "error", args: ["second"] })).toBe(true);
      const firstBatch = first.messages.find(
        (message: DiskIOMessage): boolean => message.type === "diagnosticBatch"
      );
      expect(firstBatch).toMatchObject({
        type: "diagnosticBatch",
        messages: [{ type: "log", args: ["first"] }],
      });
      expect(diskIORuntime.diagnosticQueue.size).toBe(2);
      expect(diskIORuntime.diagnosticQueue.awaitingAcknowledgement).toBe(true);

      pauseDiskIODiagnosticChannel();
      const second: FakeWorker = new FakeWorker("replacement-disk-worker.ts");
      diskIORuntime.worker = second as unknown as Worker;
      diskIORuntime.writable = true;
      resumeDiskIODiagnosticChannel(second as unknown as Worker);
      const replayed = second.messages.find(
        (message: DiskIOMessage): boolean => message.type === "diagnosticBatch"
      );
      expect(replayed).toEqual(firstBatch);

      if (replayed?.type !== "diagnosticBatch") throw new Error("missing replayed diagnostics");
      acceptDiskIODiagnosticBatch(second as unknown as Worker, replayed.batchId);
      const batches = second.messages.filter(
        (message: DiskIOMessage): boolean => message.type === "diagnosticBatch"
      );
      expect(batches[1]).toMatchObject({
        type: "diagnosticBatch",
        messages: [{ type: "log", args: ["second"] }],
      });
    } finally {
      diskIORuntime.respawnListeners.length = 0;
      diskIORuntime.respawnListeners.push(...registrations);
      await diskIO.terminateDiskIO();
      error.mockRestore();
      globalThis.Worker = originalWorker;
    }
  });

  test("进程级 flush 等有界诊断 FIFO 全部 durable 后才把最终 flush 交给 Worker", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;
      worker.messages.length = 0;

      for (let index: number = 0; index < 33; index++) {
        diskIO.relayLogMessage({ timestamp: index, level: "error", args: [String(index)] });
      }
      const flushPromise: Promise<string> = diskIO.flushDiskIO(1_000);
      expect(worker.messages.some(
        (message: DiskIOMessage): boolean => message.type === "flush"
      )).toBe(false);

      const firstBatch = worker.messages[0];
      if (firstBatch?.type !== "diagnosticBatch") throw new Error("missing first diagnostic batch");
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: firstBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      const secondBatch = worker.messages[1];
      if (secondBatch?.type !== "diagnosticBatch") throw new Error("missing second diagnostic batch");
      expect(secondBatch.messages).toHaveLength(32);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: secondBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      await Bun.sleep(0);

      const flush = worker.messages.find(
        (message: DiskIOMessage): boolean => message.type === "flush"
      );
      if (flush?.type !== "flush") throw new Error("missing final disk flush");
      worker.onmessage!({
        data: { type: "flushed", flushedId: flush.flushId },
      } as MessageEvent<DiskIOReply>);
      await expect(flushPromise).resolves.toBe("flushed");
    } finally {
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
    }
  });

  test("诊断载荷越过字节硬顶时释放原消息，flush 仍会落盘汇总哨兵", async () => {
    FakeWorker.instances.length = 0;
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise: Promise<unknown> = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loadedPromise;
      worker.messages.length = 0;

      expect(diskIO.relayLogMessage({
        timestamp: 1,
        level: "error",
        args: ["x".repeat(DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES)],
      })).toBeTrue();
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticQueue.size).toBe(0);
      expect(diskIORuntime.diagnosticDroppedMessages).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("queue capacity reached"));

      const flushPromise: Promise<string> = diskIO.flushDiskIO(1_000);
      const batch: DiskIOMessage | undefined = worker.messages[0];
      if (batch?.type !== "diagnosticBatch") throw new Error("missing diagnostic summary batch");
      expect(batch.messages).toHaveLength(1);
      expect(batch.messages[0]).toMatchObject({
        type: "log",
        args: [expect.stringContaining("dropped 1 diagnostic message")],
      });
      expect(diskIORuntime.diagnosticDroppedMessages).toBe(0);
      expect(diskIORuntime.diagnosticDroppedSerializedBytes).toBe(0);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: batch.batchId },
      } as MessageEvent<DiskIOReply>);
      await Bun.sleep(0);
      const flush: DiskIOMessage | undefined = worker.messages[1];
      if (flush?.type !== "flush") throw new Error("missing final disk flush");
      worker.onmessage!({
        data: { type: "flushed", flushedId: flush.flushId },
      } as MessageEvent<DiskIOReply>);
      await expect(flushPromise).resolves.toBe("flushed");
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
    await expect(diskIO.flushDiskIODomain("blocklist", 1_000)).resolves.toBe("failed");
    // 没有本次请求的回执时不得报出任何领域名：那只会是别的 flush 留下的旧值，
    // 把运维引向一个跟本次失败无关的文件。
    await expect(diskIO.flushDiskIODomainOutcome("blocklist", 1_000)).resolves.toEqual({ result: "failed" });
  });
});
