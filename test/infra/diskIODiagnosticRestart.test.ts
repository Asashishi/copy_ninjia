import { describe, expect, spyOn, test } from "bun:test";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import {
  DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD,
  DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES,
} from "../../packages/consts/diskIO/diagnostics";
import type { DiskIOMessage, DiskIOReply } from "../../packages/types";
import {
  emitSuccessfulDiskIOLoad as emitSuccessfulLoad,
  FakeDiskIOWorker as FakeWorker,
  installFakeDiskIOWorker,
  lastDiskIOMessage,
} from "../helpers/diskIOWorkerHarness";

const diskIO = await import("../../packages/infra/diskIO");

function latestDiagnosticBatch(
  worker: FakeWorker
): Extract<DiskIOMessage, { type: "diagnosticBatch" }> {
  return lastDiskIOMessage(worker, "diagnosticBatch");
}

function emitBusinessFlush(
  worker: FakeWorker,
  success: boolean = true
): void {
  const request: Extract<DiskIOMessage, { type: "flush" }> =
    lastDiskIOMessage(worker, "flush");
  worker.onmessage!({ data: success
    ? { type: "flushed", flushedId: request.flushId }
    : {
      type: "flushFailed",
      flushedId: request.flushId,
      failedDomains: ["joinLog"],
    },
  } as MessageEvent<DiskIOReply>);
}

async function failCurrentBatch(worker: FakeWorker): Promise<void> {
  const batch: Extract<DiskIOMessage, { type: "diagnosticBatch" }> =
    latestDiagnosticBatch(worker);
  worker.onmessage!({ data: {
    type: "diagnosticBatchRetry",
    batchId: batch.batchId,
    retryAfterMs: 0,
  } } as MessageEvent<DiskIOReply>);
  await Bun.sleep(1);
}

describe("Disk I/O diagnostic failure recycling", () => {
  test("成功 ACK 清零连续失败，第 45 次失败受控重建并由新代际重投原批", async () => {
    expect(DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES).toBe(45);
    const restoreWorker: () => void = installFakeDiskIOWorker();
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      diskIO.initDiskIO();
      const first: FakeWorker = FakeWorker.instances[0]!;
      const loaded: Promise<unknown> = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(first);
      await loaded;
      await Bun.sleep(0);
      first.messages.length = 0;

      diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["first"] });
      for (let failure: number = 0; failure < 44; failure++) {
        await failCurrentBatch(first);
      }
      expect(FakeWorker.instances).toHaveLength(1);
      expect(diskIORuntime.consecutiveDiagnosticWriteFailures).toBe(44);

      const accepted: Extract<DiskIOMessage, { type: "diagnosticBatch" }> =
        latestDiagnosticBatch(first);
      first.onmessage!({ data: {
        type: "diagnosticBatchAccepted",
        batchId: accepted.batchId,
      } } as MessageEvent<DiskIOReply>);
      expect(diskIORuntime.consecutiveDiagnosticWriteFailures).toBe(0);
      expect(diskIORuntime.diagnosticQueue.size).toBe(0);

      diskIO.relayLogMessage({ timestamp: 2, level: "error", args: ["second"] });
      for (let failure: number = 0; failure < 44; failure++) {
        await failCurrentBatch(first);
      }
      expect(FakeWorker.instances).toHaveLength(1);
      expect(first.terminated).toBeFalse();

      const retained: Extract<DiskIOMessage, { type: "diagnosticBatch" }> =
        latestDiagnosticBatch(first);
      await failCurrentBatch(first);
      expect(first.terminated).toBeFalse();
      expect(diskIORuntime.writable).toBeFalse();
      expect(first.messages.at(-1)?.type).toBe("flush");
      emitBusinessFlush(first);
      await Bun.sleep(0);
      expect(first.terminated).toBeTrue();
      expect(FakeWorker.instances).toHaveLength(2);
      expect(diskIORuntime.consecutiveDiagnosticWriteFailures).toBe(0);
      expect(diskIORuntime.consecutiveDiagnosticRebuilds).toBe(1);
      const second: FakeWorker = FakeWorker.instances[1]!;
      expect(second.messages).toEqual([expect.objectContaining({ type: "load" })]);

      // 旧代际迟到回执不能确认或释放当前原批。
      first.onmessage!({ data: {
        type: "diagnosticBatchAccepted",
        batchId: retained.batchId,
      } } as MessageEvent<DiskIOReply>);
      expect(diskIORuntime.diagnosticQueue.size).toBe(1);

      emitSuccessfulLoad(second);
      await Bun.sleep(0);
      expect(latestDiagnosticBatch(second)).toEqual(retained);
      expect(diskIORuntime.writable).toBeTrue();

      second.onmessage!({ data: {
        type: "diagnosticBatchAccepted",
        batchId: retained.batchId,
      } } as MessageEvent<DiskIOReply>);
      expect(diskIORuntime.diagnosticQueue.size).toBe(0);
      expect(diskIORuntime.consecutiveDiagnosticRebuilds).toBe(0);
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      restoreWorker();
    }
  });

  test("日志失败链第三次要求重建时中断 bot，普通崩溃预算不参与该计数", async () => {
    expect(DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD).toBe(3);
    const restoreWorker: () => void = installFakeDiskIOWorker();
    const error = spyOn(console, "error").mockImplementation((): void => {});
    const fatals: Error[] = [];
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error): void => { fatals.push(fatal); } });
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loaded: Promise<unknown> = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loaded;
      await Bun.sleep(0);
      worker.messages.length = 0;

      diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["persistent"] });
      diskIORuntime.consecutiveDiagnosticWriteFailures =
        DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES - 1;
      diskIORuntime.consecutiveDiagnosticRebuilds =
        DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD - 1;
      await failCurrentBatch(worker);
      expect(worker.terminated).toBeFalse();
      emitBusinessFlush(worker);
      await Bun.sleep(0);

      expect(worker.terminated).toBeTrue();
      expect(FakeWorker.instances).toHaveLength(1);
      expect(diskIORuntime.worker).toBeNull();
      expect(fatals).toHaveLength(1);
      expect(fatals[0]?.message).toContain("restart budget");
      expect(diskIORuntime.diagnosticQueue.size).toBe(1);
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      restoreWorker();
    }
  });

  test("受控重建前业务 flush 失败会立即 fatal，不猜测非日志事实已落盘", async () => {
    const restoreWorker: () => void = installFakeDiskIOWorker();
    const error = spyOn(console, "error").mockImplementation((): void => {});
    const fatals: Error[] = [];
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error): void => { fatals.push(fatal); } });
      const worker: FakeWorker = FakeWorker.instances[0]!;
      const loaded: Promise<unknown> = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(worker);
      await loaded;
      await Bun.sleep(0);
      worker.messages.length = 0;

      diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["persistent"] });
      diskIORuntime.consecutiveDiagnosticWriteFailures =
        DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES - 1;
      await failCurrentBatch(worker);
      emitBusinessFlush(worker, false);
      await Bun.sleep(0);

      expect(worker.terminated).toBeTrue();
      expect(FakeWorker.instances).toHaveLength(1);
      expect(diskIORuntime.worker).toBeNull();
      expect(fatals).toHaveLength(1);
      expect(fatals[0]?.message).toContain("business flush failed");
      expect(diskIORuntime.diagnosticQueue.size).toBe(1);
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      restoreWorker();
    }
  });
});
