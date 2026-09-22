import { describe, expect, test } from "bun:test";
import type { DiskIOMessage, DiskIOOperationMessage } from "../../packages/types";
import type { AdSampleDiskMessage } from "../../packages/types/diskIO/messages";
import { DISK_BUSINESS_BATCH_MAX_MESSAGES } from "../../packages/consts/diskIO/business";
import {
  adoptAiMemorySnapshots,
  adoptLogFiles,
  adoptLuckDay,
  adoptStickerCatalogSnapshots,
  adoptStorageDatabase,
  adoptVerificationDay,
  consoleError,
  consumeJoinLogRejection,
  deleteAiMemorySnapshot,
  diskIOMaintenanceCron,
  flushAiMemorySnapshots,
  flushBlocklistRemovalOutbox,
  flushJoinLogDomain,
  flushLogBuffer,
  flushLuckAppends,
  flushStickerCatalogs,
  flushVerificationChanges,
  handleAdSampleMessage,
  handleBlocklistRemovalsMessage,
  handleChatQaWrite,
  handleChatStateWrite,
  handleIdentityPolicyWrite,
  handleJoinLogMessage,
  handleLogMessage,
  handleLuckDrawMessage,
  handleTemporaryAdBypassWrite,
  handleVerificationDelete,
  hydrateLuckDay,
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
  queueDiskIOWorkerMessage,
  readJoinLog,
  recoverLuckReceiptSecret,
  rejectedStorageDomains,
  route,
} from "../helpers/diskIOWorkerRouterHarness";
import type { StickerInspection } from "../helpers/diskIOWorkerRouterHarness";

describe("Disk I/O Worker protocol router", () => {
  test("把各业务消息准确交给唯一领域 owner", async () => {
    await route({
      type: "diagnosticBatch",
      batchId: 7,
      messages: [{ type: "log", timestamp: 1, level: "error", args: ["boom"] }],
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

  /**
   * 业务批次分派此前一行没跑过（既有用例全部逐条 route 单条消息）。这里把
   * 「批内逐条派发 + 回执」与三条入参校验一起钉住：批号与批长都是协议不变量，
   * 越界必须当场抛，不能吞掉半个批次再回一个 accepted。
   */
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
      messages: [{ type: "log", timestamp: 1, level: "error", args: ["retry"] }],
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "diagnosticBatchRetry",
      batchId: 9,
      retryAfterMs: 300_000,
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
      messages: [sample, { type: "log", timestamp: 1, level: "error", args: ["retry"] }],
    };
    flushLogBuffer.mockReturnValueOnce(false);

    await route(batch);
    expect(handleLogMessage).toHaveBeenCalledTimes(1);
    expect(handleAdSampleMessage).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "diagnosticBatchRetry", batchId: 12, retryAfterMs: 300_000 });

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
      // 校验失败必须留在当前消息边界内；异常离开 onmessage 会让 Bun 终止落盘线程，
      // 连带丢失各领域的进程内缓冲并触发重启节流。
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
    // 主线程只能靠下一次领域 flush 的失败回执才知道这条最终值没落盘——
    // /block 的 confirmBlocklistPersisted 正是这么问的。
    expect([...rejectedStorageDomains].sort()).toEqual([
      "blocklistRemovalOutbox",
      "temporaryAdBypass",
      "whitelist",
    ]);
    // 在线消息不升级为停机：主线程仍持有未 ACK 的 revision，Worker 重建时重放。
    expect(postMessage).not.toHaveBeenCalled();
    rejectedStorageDomains.clear();
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

    // 重放的这条对应的 update 早已被确认过，后面不会再有 flush 来问它。
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
    const stateMessage: DiskIOMessage = { aiPersona: null,
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

  test("入群事实的 owner 抛错不逸出 onmessage，改记拒收让统一 flush 回报失败", async () => {
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Failed to flush join logs before day rollover cleanup.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      // 逸出 onmessage 的异常会被 Bun 直接终止整条落盘线程：在途 flush 全按失败
      // 结算、各领域缓冲随线程一起没了，反复触发还会把整个进程停掉。
      await expect(route({
        type: "joinLog",
        chatId: -1,
        userId: 42,
        joinedAt: 1_000,
        day: "1970-01-01",
      })).resolves.toBeUndefined();
    } finally {
      console.error = originalConsoleError;
    }
    expect(consoleError).toHaveBeenCalledTimes(1);
    // 代价只落在 joinLog 这一个领域：拒收标记让 recordJoinLog 紧接着那次
    // flush 拿到 flushFailed，该 update 不被确认，Telegram 重投。
    expect(consumeJoinLogRejection()).toBeTrue();
    // 在线消息不升级为停机：它后面紧跟着调用方自己的 flush。
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("恢复缓冲重放期间的入群写失败升级为停机回执，不只是记拒收", async () => {
    // 重放的这条在崩溃窗口里就已经被 recordJoinLog 放行、update 也确认过了，
    // 后面没有任何 flush 会再问它写没写进去。只记拒收的话，标记会挂到某个无关的
    // 后续入群事实那次 flush 上——那一条被连坐重投，真正丢掉的这一条毫无痕迹。
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Join log buffer reached its hard limit of 4096 entries.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "recoveryReplay", active: true });
      await expect(route({
        type: "joinLog",
        chatId: -1,
        userId: 42,
        joinedAt: 1_000,
        day: "1970-01-01",
      })).resolves.toBeUndefined();
      await route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "recoveryReplayFailed",
      domain: "joinLog",
      error: "Join log buffer reached its hard limit of 4096 entries.",
    });
    // 拒收标记照记不误：停机路径与领域内的回报互不取代。
    expect(consumeJoinLogRejection()).toBeTrue();
  });

  test("重放窗口关闭后写失败回到常规语义，不再升级为停机", async () => {
    await route({ type: "recoveryReplay", active: true });
    await route({ type: "recoveryReplay", active: false });
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Failed to flush join logs before day rollover cleanup.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "joinLog", chatId: -1, userId: 42, joinedAt: 1_000, day: "1970-01-01" });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).not.toHaveBeenCalled();
    expect(consumeJoinLogRejection()).toBeTrue();
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
    expect(hydrateLuckDay).toHaveBeenCalledWith("2026-07-22");
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
    expect(hydrateLuckDay).toHaveBeenCalledWith("2026-07-22");
    expect(flushLuckAppends.mock.invocationCallOrder[0]).toBeLessThan(hydrateLuckDay.mock.invocationCallOrder[0]!);

    flushLuckAppends.mockClear();
    hydrateLuckDay.mockClear();
    recoverLuckReceiptSecret.mockClear();
    postMessage.mockClear();
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };
    flushLuckAppends.mockReturnValueOnce(false);

    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 11 });

    expect(hydrateLuckDay).not.toHaveBeenCalled();
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
    expect(hydrateLuckDay).not.toHaveBeenCalled();
    expect(recoverLuckReceiptSecret).not.toHaveBeenCalled();
    expect(luckWorkerCache.current.day).toBe("2026-07-22");
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 12,
      error: "Refusing to move luck persistence backward from 2026-07-22 to 2026-07-21.",
    });
  });

  test("启动恢复先加载当天结果，再把确认数交给密钥一致性检查", async () => {
    hydratedLuckEntries.current.set("confirmed", { label: "大吉", fortunePercent: 99 });

    await route({ type: "load", stickerPacks: ["pack_a"] });

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
    await route({ type: "load", stickerPacks: ["pack_b"] });

    expect(inspectStickerCatalogs).toHaveBeenCalledWith(["pack_b"]);
  });

  test("白名单可读时先只读 inspect，成功回执后才执行孤儿维护", async () => {
    await route({ type: "load", stickerPacks: ["pack_a"] });

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
      type: "load",
      stickerPacks: ["pack_a"],
    });
    const write: Promise<void> = queueDiskIOWorkerMessage({
      type: "joinLog",
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
    const load: Promise<void> = queueDiskIOWorkerMessage({ type: "load", stickerPacks: [] });
    const write: Promise<void> = queueDiskIOWorkerMessage({
      type: "joinLog", chatId: -1, userId: 42, joinedAt: 1_000, day: "1970-01-01",
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
      await route({ type: "load", stickerPacks: ["pack_a"] });
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
      await route({ type: "load", stickerPacks: ["pack_a"] });
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
    flushAiMemorySnapshots.mockReturnValueOnce(false);
    await route({ type: "flush", flushId: 11, scope: "all" });

    for (const fn of [
      flushLogBuffer,
      flushAiMemorySnapshots,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
      flushJoinLogDomain,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    // 按领域而不是一个合取布尔：等自己那条记录落盘的调用方（/block）不该被
    // 无关领域的失败误导——那会把运维引向一个其实没坏的文件，而真正坏掉的
    // 领域按设计只有 console.error，永远进不了 logs/。
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 11,
      failedDomains: ["aiMemory"],
    });

    flushBlocklistRemovalOutbox.mockReturnValueOnce(false);
    await route({ type: "flush", flushId: 12, scope: "all" });
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
      flushAiMemorySnapshots,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
      flushJoinLogDomain,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 13 });
  });

  test("各领域全部成功时回执不带失败领域", async () => {
    await route({ type: "flush", flushId: 14, scope: "all" });

    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 14 });
  });
});
