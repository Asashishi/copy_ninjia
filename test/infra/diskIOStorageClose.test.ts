/** 主线程 terminateDiskIO 的停机关库步骤：发送条件，以及无法确认残余写已提交时照常终止后 reject。 */

import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { DISK_IO_STORAGE_CLOSE_TIMEOUT_MS } from "../../packages/consts/lifecycle";
import { initDiskIO, loadPersistedData, terminateDiskIO } from "../../packages/infra/diskIO";
import type { DiskIOMessage } from "../../packages/types/diskIO/messages";
import type { DiskIOReply, StorageCloseOutcome } from "../../packages/types/diskIO/replies";
import { waitUntil } from "../helpers/waitUntil";
import {
  emitSuccessfulDiskIOLoad,
  FakeDiskIOWorker,
  installFakeDiskIOWorker,
  lastDiskIOMessage,
} from "../helpers/diskIOWorkerHarness";

let restoreWorker: () => void;
let consoleError: Mock<typeof console.error>;
const fatals: Error[] = [];

function worker(): FakeDiskIOWorker {
  return FakeDiskIOWorker.instances.at(-1)!;
}

function closeRequests(target: FakeDiskIOWorker): DiskIOMessage[] {
  return target.messages.filter((message: DiskIOMessage): boolean => message.type === "closeStorage");
}

function replyStorageClosed(target: FakeDiskIOWorker, payload: { outcome?: StorageCloseOutcome; error?: string }): void {
  const request = lastDiskIOMessage(target, "closeStorage");
  target.onmessage!({ data: { type: "storageClosed", requestId: request.requestId, ...payload } } as MessageEvent<DiskIOReply>);
}

/** 初始化并完成恢复握手，等到当前代际可写。 */
async function initWritableDiskIO(): Promise<FakeDiskIOWorker> {
  initDiskIO({ onFatal: (error: Error): void => { fatals.push(error); } });
  const loading: Promise<unknown> = loadPersistedData();
  emitSuccessfulDiskIOLoad(worker());
  await loading;
  await waitUntil((): boolean => diskIORuntime.writable);
  return worker();
}

beforeEach(async (): Promise<void> => {
  await terminateDiskIO();
  fatals.length = 0;
  restoreWorker = installFakeDiskIOWorker();
  consoleError = spyOn(console, "error").mockImplementation((): void => {});
});

afterEach(async (): Promise<void> => {
  jest.useRealTimers();
  await terminateDiskIO();
  consoleError.mockRestore();
  restoreWorker();
});

describe("terminateDiskIO 的停机关库", () => {
  test("可写代际先置不可写并发送一次 closeStorage，收到回执后才 terminate", async () => {
    const target: FakeDiskIOWorker = await initWritableDiskIO();
    target.autoCloseStorage = false;

    const terminating: Promise<void> = terminateDiskIO();
    expect(diskIORuntime.writable).toBeFalse();
    expect(closeRequests(target)).toHaveLength(1);
    expect(target.terminated).toBeFalse();

    replyStorageClosed(target, { outcome: { committed: true, checkpointBusy: false } });
    await terminating;

    expect(target.terminated).toBeTrue();
    expect(diskIORuntime.worker).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("Worker 不回执时等满关库预算后照常 terminate，再以无法确认残余写提交的错误 reject", async () => {
    const target: FakeDiskIOWorker = await initWritableDiskIO();
    target.autoCloseStorage = false;
    jest.useFakeTimers();

    const terminating: Promise<void> = terminateDiskIO();
    jest.advanceTimersByTime(DISK_IO_STORAGE_CLOSE_TIMEOUT_MS);

    await expect(terminating).rejects.toThrow("could not confirm that residual storage writes were committed");
    expect(target.terminated).toBeTrue();
    expect(diskIORuntime.worker).toBeNull();
  });

  test("回执报错或残余写未提交时照常 terminate 后 reject；只是 checkpoint 被挡住时写诊断并 resolve", async () => {
    const failed: FakeDiskIOWorker = await initWritableDiskIO();
    failed.autoCloseStorage = false;
    const terminatingFailed: Promise<void> = terminateDiskIO();
    replyStorageClosed(failed, { error: "database is locked" });
    await expect(terminatingFailed).rejects.toThrow("could not confirm that residual storage writes were committed");
    expect(failed.terminated).toBeTrue();

    const uncommitted: FakeDiskIOWorker = await initWritableDiskIO();
    uncommitted.autoCloseStorage = false;
    const terminatingUncommitted: Promise<void> = terminateDiskIO();
    replyStorageClosed(uncommitted, { outcome: { committed: false, checkpointBusy: false } });
    await expect(terminatingUncommitted).rejects.toThrow("residual storage writes were not committed");
    expect(uncommitted.terminated).toBeTrue();
    expect(consoleError).not.toHaveBeenCalled();

    const busy: FakeDiskIOWorker = await initWritableDiskIO();
    busy.autoCloseStorage = false;
    const terminatingBusy: Promise<void> = terminateDiskIO();
    replyStorageClosed(busy, { outcome: { committed: true, checkpointBusy: true } });
    await terminatingBusy;
    expect(busy.terminated).toBeTrue();
    expect(consoleError.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
      expect.stringContaining("WAL checkpoint was blocked by another database reader"),
    ]);
  });

  test("已发出致命信号、尚未完成恢复握手或从未初始化时不发送 closeStorage", async () => {
    const fatal: FakeDiskIOWorker = await initWritableDiskIO();
    diskIORuntime.fatalSignaled = true;
    await terminateDiskIO();
    expect(closeRequests(fatal)).toHaveLength(0);
    expect(fatal.terminated).toBeTrue();

    initDiskIO();
    const loading: FakeDiskIOWorker = worker();
    await terminateDiskIO();
    expect(closeRequests(loading)).toHaveLength(0);
    expect(loading.terminated).toBeTrue();

    await expect(terminateDiskIO()).resolves.toBeUndefined();
  });

  test("Worker 回 storageWriteStalled 时宿主只通知一次致命故障", async () => {
    const target: FakeDiskIOWorker = await initWritableDiskIO();
    target.onmessage!({ data: { type: "storageWriteStalled" } } as MessageEvent<DiskIOReply>);
    target.onmessage!({ data: { type: "storageWriteStalled" } } as MessageEvent<DiskIOReply>);

    expect(fatals.map((error: Error): string => error.message)).toEqual([
      "Storage database writes stalled; refusing new business writes.",
    ]);
  });
});
