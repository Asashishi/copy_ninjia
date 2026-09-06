import { afterEach, beforeEach, expect, test } from "bun:test";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { defaultStickerConfigCache } from "../../packages/cache/perThread/config";
import { temporaryWhitelistActivityCache, temporaryWhitelistWriteRevision, unacknowledgedTemporaryWhitelistWrites } from "../../packages/cache/main/temporaryWhitelist";
import { resetIdentityStorageCache } from "../../packages/cache/main/identityStorage";
import { recordTemporaryWhitelistActivity } from "../../packages/infra/identityPolicy/temporaryWhitelist";
import { initDiskIO, postDiskIO, terminateDiskIO, loadPersistedData, readIdentityPolicies, flushDiskIO } from "../../packages/infra/diskIO";
import { DISK_BUSINESS_MAX_RETAINED_BYTES } from "../../packages/consts/diskIO/business";
import type { DiskIOReply, TemporaryWhitelistWriteDiskMessage } from "../../packages/types/diskIO";
import { emitSuccessfulDiskIOLoad, FakeDiskIOWorker, installFakeDiskIOWorker, crashDiskIOWorker } from "../helpers/diskIOWorkerHarness";

let restoreWorker: () => void;
const fatals: Error[] = [];
function worker(): FakeDiskIOWorker { return FakeDiskIOWorker.instances.at(-1)!; }
function write(id: number): TemporaryWhitelistWriteDiskMessage { return { type: "temporaryWhitelistWrite", id, activity: null, revision: id }; }
function acknowledge(target: FakeDiskIOWorker): void {
  target.onmessage!({ data: { type: "operationBatchAccepted", batchId: target.operationBatches.at(-1)!.batchId } } as MessageEvent<DiskIOReply>);
}
beforeEach(async (): Promise<void> => {
  await terminateDiskIO(); resetIdentityStorageCache(); fatals.length = 0;
  restoreWorker = installFakeDiskIOWorker();
  initDiskIO({ maxPendingBusinessMessages: 3, onFatal: (error: Error): void => { fatals.push(error); } });
  const loading: Promise<unknown> = loadPersistedData(); emitSuccessfulDiskIOLoad(worker()); await loading;
  worker().autoAcknowledgeOperations = false;
});
afterEach(async (): Promise<void> => { await terminateDiskIO(); resetIdentityStorageCache(); restoreWorker(); });

test("非消费 Worker 只有一个在途批次；条数满后保留原事实并只通知一次", (): void => {
  for (let id: number = 1; id <= 3; id++) expect(postDiskIO(write(id))).toBeTrue();
  expect(worker().operationBatches).toHaveLength(1);
  expect(diskIORuntime.operationQueue.size).toBe(3);
  expect(postDiskIO(write(4))).toBeFalse(); expect(postDiskIO(write(5))).toBeFalse();
  expect(fatals).toHaveLength(1); expect(diskIORuntime.operationQueue.size).toBe(3);
});

test("传输满额在临时白名单 LRU、revision 和未 ACK 发布之前拒收", (): void => {
  for (let id: number = 1; id <= 3; id++) postDiskIO(write(id));
  temporaryWhitelistActivityCache.set(9, null);
  expect((): unknown => recordTemporaryWhitelistActivity(9)).toThrow("publication");
  expect(temporaryWhitelistActivityCache.peek(9)).toBeNull();
  expect(temporaryWhitelistWriteRevision.current).toBe(0);
  expect(unacknowledgedTemporaryWhitelistWrites.size).toBe(0);
});

test("大载荷按字节拒收，未发送且不制造恢复事实", (): void => {
  expect(postDiskIO({ type: "aiMemory", chatId: -1, revision: 1, snapshot: "x".repeat(DISK_BUSINESS_MAX_RETAINED_BYTES / 2) })).toBeFalse();
  expect(worker().operationBatches).toHaveLength(0);
  expect(diskIORuntime.operationQueue.size).toBe(0);
});

test("读取和 flush 必须在已入队业务之后消费；消费 ACK 不等同于落盘 ACK", async (): Promise<void> => {
  temporaryWhitelistActivityCache.set(7, null); recordTemporaryWhitelistActivity(7);
  const reading: Promise<unknown> = readIdentityPolicies([7]).catch((): undefined => undefined);
  const flushing: Promise<unknown> = flushDiskIO();
  expect(worker().messages.map((message): string => message.type)).toEqual(["load", "temporaryWhitelistWrite"]);
  acknowledge(worker());
  expect(worker().operationBatches.at(-1)!.messages.map((message): string => message.type)).toEqual(["readIdentityPolicies", "flush"]);
  expect(unacknowledgedTemporaryWhitelistWrites.size).toBe(1);
  expect(diskIORuntime.operationTimer?.hasRef()).toBeFalse();
  await terminateDiskIO(); await reading; await flushing;
});

test("崩溃按原序重放未消费业务；旧代 ACK 不释放新队列", async (): Promise<void> => {
  postDiskIO(write(1)); postDiskIO(write(2));
  const previous: FakeDiskIOWorker = worker();
  const replacement: FakeDiskIOWorker = crashDiskIOWorker(previous);
  replacement.autoAcknowledgeOperations = false;
  expect(diskIORuntime.pendingBusinessMessages.size).toBe(2);
  emitSuccessfulDiskIOLoad(replacement); await Bun.sleep(0);
  const retained: number = diskIORuntime.operationQueue.size;
  acknowledge(previous); expect(diskIORuntime.operationQueue.size).toBe(retained);
  acknowledge(replacement);
  expect(replacement.operationBatches.at(-1)!.messages.filter((message): boolean => message.type === "temporaryWhitelistWrite").map((message): number => (message as TemporaryWhitelistWriteDiskMessage).id)).toEqual([1, 2]);
});

test("缺省贴纸配置在初始 load 与运行时恢复都明确发送 null", async (): Promise<void> => {
  const previous: typeof defaultStickerConfigCache.current = defaultStickerConfigCache.current;
  defaultStickerConfigCache.current = null;
  try {
    const loading: Promise<unknown> = loadPersistedData();
    expect(worker().messages.at(-1)).toEqual({ type: "load", stickerPacks: null });
    emitSuccessfulDiskIOLoad(worker()); await loading;
    const replacement: FakeDiskIOWorker = crashDiskIOWorker(worker());
    expect(replacement.messages[0]).toEqual({ type: "load", stickerPacks: null });
  } finally { defaultStickerConfigCache.current = previous; }
});

test("未 ACK 主键达到上限后不通过 LRU 淘汰释放持久化事实", (): void => {
  for (let id: number = 1; id <= 8_192; id++) unacknowledgedTemporaryWhitelistWrites.set(id, { activity: null, revision: id });
  temporaryWhitelistActivityCache.set(9_000, null);
  expect((): unknown => recordTemporaryWhitelistActivity(9_000)).toThrow("capacity");
  expect(unacknowledgedTemporaryWhitelistWrites.size).toBe(8_192);
  expect(temporaryWhitelistActivityCache.peek(9_000)).toBeNull();
  expect(temporaryWhitelistWriteRevision.current).toBe(0);
  expect(worker().operationBatches).toHaveLength(0);
});

test("消费 ACK 超时仅停止新入口，仍保留业务事实供最终 flush", async (): Promise<void> => {
  const { jest } = await import("bun:test");
  const { DISK_BUSINESS_ACK_TIMEOUT_MS } = await import("../../packages/consts/diskIO/business");
  jest.useFakeTimers();
  try {
    postDiskIO(write(1));
    jest.advanceTimersByTime(DISK_BUSINESS_ACK_TIMEOUT_MS);
    expect(fatals[0]?.message).toContain("timed out");
    expect(diskIORuntime.operationQueue.size).toBe(1);
    expect(postDiskIO(write(2))).toBeFalse();
    expect(worker().terminated).toBeFalse();
  } finally { jest.useRealTimers(); }
});
