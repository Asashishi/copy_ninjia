import { adoptTimeZone, getTimeZone } from "../../packages/config/time";
import { afterEach, describe, expect, test } from "bun:test";
import type { DiskIOMessage, DiskIOOperationMessage, AdSampleDiskMessage } from "../../packages/types/diskIO/messages";
import type { DiskIODomain } from "../../packages/types/diskIO/replies";

import { DISK_BUSINESS_BATCH_MAX_MESSAGES } from "../../packages/consts/diskIO/business";
import { LOG_REOPEN_RETRY_MS } from "../../packages/consts/diskIO/appendOnly";
import {
  adoptAiMemorySnapshots,
  adoptLogFiles,
  adoptLuckDay,
  adoptStickerCatalogSnapshots,
  adoptStorageDatabase,
  adoptVerificationDay,
  consoleError,
  deleteAiMemorySnapshot,
  diskIOMaintenanceCron,
  flushAdSampleBuffer,
  flushBlocklistRemovalOutbox,
  flushJoinLogBuffer,
  flushLogBuffer,
  flushLuckAppends,
  flushStickerCatalogs,
  flushVerificationChanges,
  collectStorageDatabaseFailures,
  handleAdSampleMessage,
  handleAiCacheUsageMessage,
  flushAiCacheBuffer,
  handleBlocklistRemovalsMessage,
  handleChatQaWrite,
  handleVerificationUpsert,
  handleChatStateWrite,
  handleIdentityPolicyWrite,
  handleJoinLogMessage,
  setStorageFlushHold,
  handleLogMessage,
  handleLuckDrawMessage,
  handleTemporaryAdBypassWrite,
  handleVerificationDelete,
  replayDeferredLuckDraws,
  switchLuckDay,
  hydratedLuckEntries,
  inspectJoinLogFiles,
  inspectLuckDay,
  inspectLuckReceiptSecret,
  inspectStickerCatalogs,
  inspectStorageDatabase,
  luckWorkerCache,
  maintainAdSampleFiles,
  maintainJoinLogFiles,
  maintainLogFiles,
  maintainLuckDay,
  maintainStickerCatalogFiles,
  maintainTemporaryAdBypassActivities,
  maintainVerificationDay,
  markAiMemorySnapshotDirty,
  markStickerCatalogSnapshotDirty,
  postMessage,
  purgeJoinLogDeletions,
  queueDiskIOWorkerMessage,
  readJoinLog,
  recoverLuckReceiptSecret,
  rejectedStorageDomains,
  route,
} from "../helpers/diskIOWorkerRouterHarness";
import type { StickerInspection } from "../helpers/diskIOWorkerRouterHarness";

const INITIAL_TIME_ZONE: string = getTimeZone();
afterEach((): void => { adoptTimeZone(INITIAL_TIME_ZONE); });

describe("Disk I/O Worker protocol router", () => {
  test("把各业务消息准确交给唯一领域 owner", async () => {
    await route({
      type: "diagnosticBatch",
      batchId: 7,
      messages: [{ type: "log", id: "log-boom", timestamp: 1, level: "error", args: ["boom"] }],
    });
    await route({
      type: "aiMemory",
      chatId: -1,
      revision: 2,
      snapshot: "memory",
      persistImmediately: true,
    });
    await route({ type: "deleteAiMemory", chatId: -1, revision: 3 });
    await route({ type: "stickerCatalog", revision: 1, pack: "pack", snapshot: "catalog" });
    await route({ type: "luckDraw", day: "2026-07-22", key: "42", label: "大吉", fortunePercent: 99 });
    await route({ type: "verificationDelete", chatId: -1, userId: 42, generation: 1, revision: 4 });
    await route({ type: "blocklistRemovals", revision: 1, removals: [] });
    await route({
      type: "joinLog",
      sequence: 1,
      chatId: -1,
      userId: 42,
      joinedAt: 1_000,
      day: "1970-01-01",
    });

    expect(handleLogMessage).toHaveBeenCalledTimes(1);
    expect(markAiMemorySnapshotDirty).toHaveBeenCalledWith({
      chatId: -1,
      revision: 2,
      snapshot: "memory",
      persistImmediately: true,
    });
    expect(deleteAiMemorySnapshot).toHaveBeenCalledWith(-1, 3);
    expect(markStickerCatalogSnapshotDirty).toHaveBeenCalledWith("pack", "catalog", 1);
    expect(handleLuckDrawMessage).toHaveBeenCalledTimes(1);
    expect(handleVerificationDelete).toHaveBeenCalledTimes(1);
    expect(handleBlocklistRemovalsMessage).toHaveBeenCalledTimes(1);
    expect(handleJoinLogMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: "diagnosticBatchAccepted",
      batchId: 7,
    });
  });

  test("诊断批次里的 AI 缓存用量进 ai-daily-usage 缓冲，统一 flush 一并刷出且失败不进回执", async () => {
    const usage = {
      type: "aiCacheUsage", kind: "tokens", timestamp: 1, capability: "text", provider: "openai", model: "m",
      inputTokens: 10, cachedInputTokens: 4, outputTokens: 1,
    } as const;
    await route({ type: "diagnosticBatch", batchId: 8, messages: [usage] });
    expect(handleAiCacheUsageMessage).toHaveBeenCalledWith(usage);
    expect(handleLogMessage).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "diagnosticBatchAccepted", batchId: 8 });

    flushAiCacheBuffer.mockImplementationOnce(async (): Promise<boolean> => false);
    await route({ type: "flush", flushId: 9, scope: "all" });
    expect(flushAiCacheBuffer).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "flushed", flushedId: 9 });
  });

  /** 批内逐条派发，批末回一条 accepted 回执。 */
  test("业务批次逐条派发并回一条 accepted", async () => {
    await route({
      type: "operationBatch",
      batchId: 11,
      messages: [
        { type: "aiMemory", chatId: -1, revision: 1, snapshot: "a", persistImmediately: false },
        { type: "deleteAiMemory", chatId: -2, revision: 2 },
      ],
    });

    expect(markAiMemorySnapshotDirty).toHaveBeenCalledTimes(1);
    expect(deleteAiMemorySnapshot).toHaveBeenCalledWith(-2, 2);
    expect(postMessage).toHaveBeenCalledWith({
      type: "operationBatchAccepted",
      batchId: 11,
    });
  });

  test("批号或批长越界一律当场抛，不发回执", async () => {
    const invalid: readonly { readonly batchId: number; readonly count: number }[] = [
      { batchId: 0, count: 1 },
      { batchId: 1.5, count: 1 },
      { batchId: 1, count: 0 },
      { batchId: 1, count: DISK_BUSINESS_BATCH_MAX_MESSAGES + 1 },
    ];
    for (const { batchId, count } of invalid) {
      const messages: DiskIOOperationMessage[] = Array.from(
        { length: count },
        (): DiskIOOperationMessage => ({ type: "deleteAiMemory", chatId: -1, revision: 1 })
      );
      await expect(route({ type: "operationBatch", batchId, messages }))
        .rejects.toThrow("Invalid Disk I/O operation batch.");
    }
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "operationBatchAccepted",
    }));
  });

  test("日志批次刷盘失败时要求主线程保留原批并按退避窗口重发", async () => {
    flushLogBuffer.mockReturnValueOnce(false);

    await route({
      type: "diagnosticBatch",
      batchId: 9,
      messages: [{ type: "log", id: "log-retry", timestamp: 1, level: "error", args: ["retry"] }],
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "diagnosticBatchRetry",
      batchId: 9,
      retryAfterMs: LOG_REOPEN_RETRY_MS,
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "diagnosticBatchAccepted",
    }));
  });

  test("诊断批次先刷日志后追加 adSample：刷盘失败不追加，重投后只追加一次", async () => {
    const sample: AdSampleDiskMessage = {
      type: "adSample",
      chatId: -1,
      senderId: 42,
      label: "spammer",
      detectedAt: "2026/09/22 00:00:00",
      reason: "spam",
      messages: [],
    };
    const batch: DiskIOMessage = {
      type: "diagnosticBatch",
      batchId: 12,
      messages: [sample, { type: "log", id: "log-retry", timestamp: 1, level: "error", args: ["retry"] }],
    };
    flushLogBuffer.mockReturnValueOnce(false);

    await route(batch);
    expect(handleLogMessage).toHaveBeenCalledTimes(1);
    expect(handleAdSampleMessage).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "diagnosticBatchRetry", batchId: 12, retryAfterMs: LOG_REOPEN_RETRY_MS });

    await route(batch);
    expect(handleLogMessage).toHaveBeenCalledTimes(2);
    expect(handleAdSampleMessage).toHaveBeenCalledTimes(1);
    expect(handleAdSampleMessage).toHaveBeenCalledWith(sample);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "diagnosticBatchAccepted", batchId: 12 });

    // 不含日志的批次不刷日志，直接追加。
    await route({ type: "diagnosticBatch", batchId: 13, messages: [sample] });
    expect(handleAdSampleMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "diagnosticBatchAccepted", batchId: 13 });
  });

  test("身份 SQLite 的三个 owner 抛错同样不逸出 onmessage，按领域记拒收", async () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("Identity 7 cannot exist in both permission_list and blocklist_entries.");
    });
    handleBlocklistRemovalsMessage.mockImplementationOnce((): void => {
      throw new Error("Pending removal row 1 contains an identity absent from the effective blocklist.");
    });
    handleTemporaryAdBypassWrite.mockImplementationOnce((): void => {
      throw new Error("Temporary ad bypass activity is invalid.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      // 校验失败必须留在当前消息边界内，见 docs/cn/04-invariants.md 的路由捕获约束。
      await expect(route({
        type: "identityPolicyWrite",
        table: "whitelist",
        id: 7,
        data: null,
        revision: 1,
      })).resolves.toBeUndefined();
      await expect(route({
        type: "blocklistRemovals",
        revision: 1,
        removals: [],
      })).resolves.toBeUndefined();
      await expect(route({
        type: "temporaryAdBypassWrite",
        id: 8,
        activity: null,
        revision: 1,
      })).resolves.toBeUndefined();
    } finally {
      console.error = originalConsoleError;
    }

    expect(consoleError).toHaveBeenCalledTimes(3);
    // 拒收按领域记入 rejectedStorageDomains，由下一次领域 flush 的失败回执回报；/block 的 confirmBlocklistPersisted 经此确认落盘。
    expect([...rejectedStorageDomains].sort()).toEqual([
      "blocklistRemovalOutbox",
      "temporaryAdBypass",
      "whitelist",
    ]);
    // 在线消息只记拒收，不发停机回执；未 ACK 的 revision 由主线程在 Worker 重建时重放。
    expect(postMessage).not.toHaveBeenCalled();
    rejectedStorageDomains.clear();
  });

  test("镜像重放区间标记按顺序交给共享 SQLite 的提交暂缓开关", async () => {
    setStorageFlushHold.mockClear();
    await route({ type: "storageFlushHold", active: true });
    await route({ type: "storageFlushHold", active: false });
    expect(setStorageFlushHold.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual([true, false]);
  });

  test("恢复重放期间的身份写失败升级为停机回执，不只是记拒收", async () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("revision must be a positive safe integer.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "recoveryReplay", active: true });
      await route({
        type: "identityPolicyWrite",
        table: "blocklist",
        id: 7,
        data: null,
        revision: 1,
      });
      await route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }

    // 重放期间的身份写失败直接发 recoveryReplayFailed 回执，不依赖后续 flush。
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "blocklist",
    }));
    rejectedStorageDomains.clear();
  });

  test("群状态与问答在线拒收只标记各自领域，恢复重放时升级为 fatal", async () => {
    for (let attempt: number = 0; attempt < 2; attempt += 1) {
      handleChatStateWrite.mockImplementationOnce((): void => {
        throw new Error("chat state write rejected");
      });
      handleChatQaWrite.mockImplementationOnce((): void => {
        throw new Error("chat QA write rejected");
      });
    }
    const stateMessage: DiskIOMessage = {
      type: "chatStateWrite",
      chatId: -1,
      data: "{}",
      revision: 1,
    };
    const qaMessage: DiskIOMessage = {
      type: "chatQaWrite",
      chatId: -1,
      q: "question",
      data: "answer",
      revision: 1,
    };
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route(stateMessage);
      await route(qaMessage);
      expect([...rejectedStorageDomains].sort()).toEqual(["chatQa", "chatState"]);
      expect(postMessage).not.toHaveBeenCalled();

      rejectedStorageDomains.clear();
      await route({ type: "recoveryReplay", active: true });
      await route(stateMessage);
      await route(qaMessage);
      await route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "chatState",
      error: "chat state write rejected",
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "chatQa",
      error: "chat QA write rejected",
    }));
    rejectedStorageDomains.clear();
  });

  test("待验证写入被拒收时不离开 onmessage：下一次领域 flush 回报一次失败，重放区间内升级为 fatal", async () => {
    const upsert: DiskIOMessage = { type: "verificationUpsert", record: {} as never, critical: false };
    handleVerificationUpsert.mockImplementationOnce((): never => {
      throw new RangeError("Verification persistence capacity exceeded.");
    });
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route(upsert);
      expect(postMessage).not.toHaveBeenCalled();
      await route({ type: "flush", flushId: 41, scope: "verification" });
      expect(postMessage).toHaveBeenLastCalledWith({ type: "flushFailed", flushedId: 41, failedDomains: ["verification"] });
      await route({ type: "flush", flushId: 42, scope: "verification" });
      expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 42 });

      handleVerificationUpsert.mockImplementationOnce((): never => {
        throw new RangeError("Verification persistence capacity exceeded.");
      });
      await route({ type: "recoveryReplay", active: true });
      await route(upsert);
      await route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "verification",
      error: "Verification persistence capacity exceeded.",
    }));
    await route({ type: "flush", flushId: 43, scope: "verification" });
  });

  test("重放窗口关闭后身份写拒收回到常规语义，只记领域拒收不升级为停机", async () => {
    await route({ type: "recoveryReplay", active: true });
    await route({ type: "recoveryReplay", active: false });
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("revision must be a positive safe integer.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "identityPolicyWrite", table: "whitelist", id: 7, data: null, revision: 1 });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).not.toHaveBeenCalled();
    expect([...rejectedStorageDomains]).toEqual(["whitelist"]);
    rejectedStorageDomains.clear();
  });

  test("入群日志查询总有显式成功或失败回执", async () => {
    await route({
      type: "readJoinLog",
      requestId: 15,
      chatId: -1,
      since: 1,
      now: 1_000,
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "joinLogRead",
      requestId: 15,
      records: [{ userId: 42, joinedAt: 1_000 }],
    });

    readJoinLog.mockImplementationOnce(() => {
      throw new Error("corrupt join log");
    });
    await route({
      type: "readJoinLog",
      requestId: 16,
      chatId: -1,
      since: 1,
      now: 1_000,
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "joinLogRead",
      requestId: 16,
      error: "corrupt join log",
    });
  });

  test("密钥请求总有显式成功或失败回执", async () => {
    hydratedLuckEntries.current.set("confirmed", { label: "大吉", fortunePercent: 99 });
    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 8 });
    expect(flushLuckAppends).toHaveBeenCalledTimes(1);
    expect(switchLuckDay).toHaveBeenCalledWith("2026-07-22", true);
    expect(recoverLuckReceiptSecret).toHaveBeenLastCalledWith({
      day: "2026-07-22",
      confirmedResultCount: 1,
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 8,
      secret: { version: 1, day: "2026-07-22", key: "secret" },
    });

    recoverLuckReceiptSecret.mockImplementationOnce(() => { throw new Error("corrupt secret"); });
    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 9 });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 9,
      error: "corrupt secret",
    });
  });

  test("跨日密钥请求先提交旧日追加缓冲，刷盘失败时不切换 owner", async () => {
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };

    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 10 });

    expect(flushLuckAppends).toHaveBeenCalledTimes(1);
    expect(switchLuckDay).toHaveBeenCalledWith("2026-07-22", true);
    expect(flushLuckAppends.mock.invocationCallOrder[0]).toBeLessThan(switchLuckDay.mock.invocationCallOrder[0]!);
    // 滞留抽签在密钥按磁盘确认结果恢复之后才补录。
    expect(recoverLuckReceiptSecret.mock.invocationCallOrder[0])
      .toBeLessThan(replayDeferredLuckDraws.mock.invocationCallOrder[0]!);

    flushLuckAppends.mockClear();
    switchLuckDay.mockClear();
    recoverLuckReceiptSecret.mockClear();
    postMessage.mockClear();
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };
    flushLuckAppends.mockReturnValueOnce(false);

    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 11 });

    expect(switchLuckDay).not.toHaveBeenCalled();
    expect(recoverLuckReceiptSecret).not.toHaveBeenCalled();
    expect(luckWorkerCache.current.day).toBe("2026-07-21");
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 11,
      error: "Failed to flush luck results before switching from 2026-07-21 to 2026-07-22.",
    });
  });

  test("早于当前 owner 日期的密钥请求被拒绝，不刷盘、不回退 owner", async () => {
    luckWorkerCache.current = { day: "2026-07-22", entries: new Map() };

    await route({ type: "ensureLuckSecret", day: "2026-07-21", requestId: 12 });

    expect(flushLuckAppends).not.toHaveBeenCalled();
    expect(switchLuckDay).not.toHaveBeenCalled();
    expect(recoverLuckReceiptSecret).not.toHaveBeenCalled();
    expect(luckWorkerCache.current.day).toBe("2026-07-22");
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 12,
      error: "Refusing to move luck persistence backward from 2026-07-22 to 2026-07-21.",
    });
  });

  test("启动恢复先接管时区并加载当天结果，再把确认数交给密钥一致性检查", async () => {
    hydratedLuckEntries.current.set("confirmed", { label: "大吉", fortunePercent: 99 });

    await route({ type: "load", timeZone: "UTC", stickerPacks: ["pack_a"] });

    expect(getTimeZone()).toBe("UTC");
    expect(inspectLuckDay).toHaveBeenCalledTimes(1);
    expect(inspectLuckReceiptSecret).toHaveBeenLastCalledWith({
      day: expect.any(String),
      confirmedResultCount: 1,
    });
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      luckReceiptSecret: expect.objectContaining({ key: "secret" }),
      error: undefined,
    }));
  });

  test("主线程已校验的贴纸白名单快照原样用于恢复 inspect", async () => {
    await route({ type: "load", timeZone: getTimeZone(), stickerPacks: ["pack_b"] });

    expect(inspectStickerCatalogs).toHaveBeenCalledWith(["pack_b"]);
  });

  test("白名单可读时先只读 inspect，成功回执后才执行孤儿维护", async () => {
    await route({ type: "load", timeZone: getTimeZone(), stickerPacks: ["pack_a"] });

    expect(inspectStickerCatalogs).toHaveBeenCalledWith(["pack_a"]);
    expect(inspectJoinLogFiles).toHaveBeenCalledTimes(1);
    expect(adoptStickerCatalogSnapshots).toHaveBeenCalledTimes(1);
    expect(maintainStickerCatalogFiles).toHaveBeenCalledTimes(1);
    expect(maintainAdSampleFiles).toHaveBeenCalledTimes(1);
    expect(maintainTemporaryAdBypassActivities).toHaveBeenCalledTimes(1);
    expect(diskIOMaintenanceCron.current).not.toBeNull();
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      maintainStickerCatalogFiles.mock.invocationCallOrder[0]!
    );
  });

  test("load 未完成时后续业务写只排队，不得穿过恢复事务", async () => {
    let releaseInspection: ((inspection: StickerInspection) => void) | null = null;
    inspectStickerCatalogs.mockImplementationOnce(
      (_packs: readonly string[]): Promise<StickerInspection> => new Promise<StickerInspection>(
        (resolve: (inspection: StickerInspection) => void): void => {
          releaseInspection = resolve;
        }
      )
    );

    const load: Promise<void> = queueDiskIOWorkerMessage({
      type: "load", timeZone: getTimeZone(),
      stickerPacks: ["pack_a"],
    });
    const write: Promise<void> = queueDiskIOWorkerMessage({
      type: "joinLog",
      sequence: 1,
      chatId: -1,
      userId: 42,
      joinedAt: 1_000,
      day: "1970-01-01",
    });
    await Bun.sleep(0);

    expect(inspectStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(handleJoinLogMessage).not.toHaveBeenCalled();
    expect(releaseInspection).not.toBeNull();
    releaseInspection!({ kind: "stickers" });
    await load;
    await write;

    expect(handleJoinLogMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      handleJoinLogMessage.mock.invocationCallOrder[0]!
    );
  });

  test("loaded 已回执但异步维护未完成时，后续写入仍等待且 cron 尚未注册", async () => {
    const entered = Promise.withResolvers<void>();
    const maintenance = Promise.withResolvers<void>();
    maintainLogFiles.mockImplementationOnce(async (): Promise<void> => {
      entered.resolve();
      await maintenance.promise;
    });
    const load: Promise<void> = queueDiskIOWorkerMessage({ type: "load", timeZone: getTimeZone(), stickerPacks: [] });
    const write: Promise<void> = queueDiskIOWorkerMessage({
      type: "joinLog", sequence: 1, chatId: -1, userId: 42, joinedAt: 1_000, day: "1970-01-01",
    });
    try {
      await entered.promise;
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "loaded" }));

      expect(handleJoinLogMessage).not.toHaveBeenCalled();
      expect(diskIOMaintenanceCron.current).toBeNull();
      maintenance.resolve();
      await load;
      await write;

      expect(handleJoinLogMessage).toHaveBeenCalledTimes(1);
      expect(diskIOMaintenanceCron.current).not.toBeNull();
    } finally {
      maintenance.resolve();
      await write;
    }
  });

  test("任一异步内容 inspect 失败时不 adopt、不维护其它领域", async () => {
    inspectStickerCatalogs.mockImplementationOnce(
      async (): Promise<StickerInspection> => {
        throw new Error("memory/sticker_catalog: $ must be readable valid JSON snapshots.");
      }
    );
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "load", timeZone: getTimeZone(), stickerPacks: ["pack_a"] });
    } finally {
      console.error = originalConsoleError;
    }

    expect(adoptLogFiles).not.toHaveBeenCalled();
    expect(adoptAiMemorySnapshots).not.toHaveBeenCalled();
    expect(adoptStickerCatalogSnapshots).not.toHaveBeenCalled();
    expect(adoptLuckDay).not.toHaveBeenCalled();
    expect(adoptVerificationDay).not.toHaveBeenCalled();
    expect(adoptStorageDatabase).not.toHaveBeenCalled();
    expect(maintainLogFiles).not.toHaveBeenCalled();

    expect(maintainStickerCatalogFiles).not.toHaveBeenCalled();
    expect(maintainAdSampleFiles).not.toHaveBeenCalled();
    expect(diskIOMaintenanceCron.current).toBeNull();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      error: "memory/sticker_catalog: $ must be readable valid JSON snapshots.",
    }));
  });

  test("最后一个 SQLite inspect 失败时不 adopt、不维护也不注册 cron", async () => {
    inspectStorageDatabase.mockImplementationOnce((): { readonly kind: "storage" } => {
      throw new Error("database/storage.sqlite: $.schema must be the current schema.");
    });
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "load", timeZone: getTimeZone(), stickerPacks: ["pack_a"] });
    } finally {
      console.error = originalConsoleError;
    }

    expect(adoptStorageDatabase).not.toHaveBeenCalled();
    expect(adoptLogFiles).not.toHaveBeenCalled();
    expect(maintainLogFiles).not.toHaveBeenCalled();

    expect(maintainStickerCatalogFiles).not.toHaveBeenCalled();
    expect(maintainJoinLogFiles).not.toHaveBeenCalled();
    expect(maintainLuckDay).not.toHaveBeenCalled();
    expect(maintainVerificationDay).not.toHaveBeenCalled();
    expect(maintainAdSampleFiles).not.toHaveBeenCalled();
    expect(maintainTemporaryAdBypassActivities).not.toHaveBeenCalled();
    expect(diskIOMaintenanceCron.current).toBeNull();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      error: "database/storage.sqlite: $.schema must be the current schema.",
    }));
  });

  test("flush 不短路其它 owner，并按领域回报失败", async () => {
    flushStickerCatalogs.mockReturnValueOnce(false);
    await route({ type: "flush", flushId: 11, scope: "all" });

    for (const fn of [
      flushLogBuffer,
      flushAdSampleBuffer,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
      flushJoinLogBuffer,
      purgeJoinLogDeletions,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    // 回执按领域列出失败清单 failedDomains。
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 11,
      failedDomains: ["stickerCatalog"],
    });

    // all/business 一次取走共享 SQLite 全部领域的失败。
    collectStorageDatabaseFailures.mockImplementationOnce(
      (_scope: DiskIODomain | null, failedDomains: DiskIODomain[]): void => { failedDomains.push("blocklistRemovalOutbox"); }
    );
    await route({ type: "flush", flushId: 12, scope: "all" });
    expect(collectStorageDatabaseFailures).toHaveBeenLastCalledWith(null, expect.any(Array));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 12,
      failedDomains: ["blocklistRemovalOutbox"],
    });
  });

  test("诊断重建前的 business flush 跳过故障日志，但完整刷完全部权威业务领域", async () => {
    await route({ type: "flush", flushId: 13, scope: "business" });

    expect(flushLogBuffer).not.toHaveBeenCalled();
    for (const fn of [
      flushAdSampleBuffer,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
      flushJoinLogBuffer,
      purgeJoinLogDeletions,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 13 });
  });

  test("单领域屏障只刷目标领域，其它领域的缓冲窗口不受影响", async () => {
    await route({ type: "flush", flushId: 15, scope: "chatState" });

    // 共享 SQLite 的各领域（含 AI 上下文）共用一个事务：任一 SQLite 领域屏障都只提交一次。
    expect(flushBlocklistRemovalOutbox).toHaveBeenCalledTimes(1);
    for (const fn of [
      flushLogBuffer,
      flushAdSampleBuffer,
      flushAiCacheBuffer,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushJoinLogBuffer,
      purgeJoinLogDeletions,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 15 });

    // AI 上下文同在共享事务缓冲里，它的领域屏障同样只提交一次 SQLite 事务。
    await route({ type: "flush", flushId: 17, scope: "aiMemory" });
    expect(flushBlocklistRemovalOutbox).toHaveBeenCalledTimes(2);
    expect(flushStickerCatalogs).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 17 });

    purgeJoinLogDeletions.mockReturnValueOnce(false);
    await route({ type: "flush", flushId: 16, scope: "joinLogPurge" });
    expect(purgeJoinLogDeletions).toHaveBeenCalledTimes(1);
    expect(flushJoinLogBuffer).not.toHaveBeenCalled();
    expect(flushBlocklistRemovalOutbox).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 16,
      failedDomains: ["joinLogPurge"],
    });
  });

  test("身份与群问答领域屏障各提交一次共享 SQLite 事务，失败时按仍待写的表回报", async () => {
    const scopes: readonly DiskIODomain[] = [
      "whitelist",
      "blocklist",
      "temporaryAdBypass",
      "blocklistRemovalOutbox",
      "chatQa",
    ];
    let flushId: number = 30;
    for (const scope of scopes) {
      flushBlocklistRemovalOutbox.mockClear();
      await route({ type: "flush", flushId, scope });
      expect(flushBlocklistRemovalOutbox).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: flushId });
      flushId++;
    }
    for (const fn of [
      flushLogBuffer,
      flushAdSampleBuffer,
      flushAiCacheBuffer,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushJoinLogBuffer,
      purgeJoinLogDeletions,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }

    // 单领域屏障只取走并回报本领域。
    collectStorageDatabaseFailures.mockImplementationOnce(
      (scope: DiskIODomain | null, failedDomains: DiskIODomain[]): void => { if (scope !== null) failedDomains.push(scope); }
    );
    await route({ type: "flush", flushId, scope: "temporaryAdBypass" });
    expect(collectStorageDatabaseFailures).toHaveBeenLastCalledWith("temporaryAdBypass", expect.any(Array));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: flushId,
      failedDomains: ["temporaryAdBypass"],
    });
  });

  test("各领域全部成功时回执不带失败领域", async () => {
    await route({ type: "flush", flushId: 14, scope: "all" });

    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 14 });
  });
});
