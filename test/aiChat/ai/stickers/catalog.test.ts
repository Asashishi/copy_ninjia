import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { aiChatWorkerAbortController } from "../../../../packages/cache/workers/aiChat/worker";
import { adoptStickerConfig, getStickerConfig } from "../../../../packages/config/stickers";
import type { AiTextResult } from "../../../../packages/types/aiChat/provider";
import type { AiStickerCatalogEvent } from "../../../../packages/types/stickers/protocol";

function generatedText(text: string): AiTextResult {
  return { ok: true, text };
}

const retryableFailure: AiTextResult = { ok: false, retryable: true };
const requestFailure: AiTextResult = { ok: false, retryable: false };

/**
 * aiChat/ai/stickers/sets.ts、aiChat/ai/imageDescription.ts 与 aiChat/provider.ts
 * 均替换为测试可控的假实现，本文件只覆盖 generatePackCatalog 的对账逻辑
 * （补/剪/失败时按兵不动/整包简介的生成时机）。
 */
const getStickerSetMock = mock(async (_pack: string): Promise<any> => null);
const describeMediaMock = mock(async (..._args: unknown[]): Promise<string | null> => null);
const describeMediaForStickerCatalogMock = mock(async (..._args: unknown[]): Promise<AiTextResult> => retryableFailure);
// 整包简介生成：默认返回一条固定简介文本，可按用例改写/断言调用次数。
const generateTextMock = mock(async (..._args: unknown[]): Promise<AiTextResult> => generatedText("一包默认简介"));
const sleepMock = mock(async (..._args: unknown[]): Promise<void> => {});

mock.module("../../../../packages/aiChat/ai/stickers/sets", () => ({
  getStickerSet: getStickerSetMock,
}));
mock.module("../../../../packages/aiChat/ai/stickers/describe", () => ({
  pickStickerVisionSource: (sticker: any) => ({ fileId: `${sticker.file_id}`, fileUniqueId: sticker.file_unique_id }),
}));
mock.module("../../../../packages/aiChat/ai/imageDescription", () => ({
  describeMedia: describeMediaMock,
  describeMediaForStickerCatalog: describeMediaForStickerCatalogMock,
}));
// 单次调用失败会按 STICKER_CATALOG_RETRY_DELAYS_MS 退避重试；测试里把
// 睡眠打成即时返回，失败用例才不会真等几分钟。
mock.module("../../../../packages/libs/sleep", () => ({ sleep: sleepMock }));
mock.module("../../../../packages/aiChat/provider", () => ({
  summaryAiProvider: () => ({ name: "google", generateText: generateTextMock }),
}));

const {
  drainStickerCatalogTasks,
  ensureStickerCatalogs,
  flushDirtyStickerCatalogs,
  generatePackCatalog,
  getCatalogEntry,
  getPackSummary,
  hydrateStickerCatalogs,
  pruneStickerCatalogs,
  retryIncompleteStickerCatalogs,
} = await import("../../../../packages/aiChat/ai/stickers/catalog");
const { transientDescriptionCache } = await import("../../../../packages/cache/workers/aiChat/imageDescription");
const {
  catalogs,
  dirtyPacks,
  failedEntries,
  generatingPacks,
  stickerCatalogRetryState,
} = await import("../../../../packages/cache/workers/aiChat/stickers/catalog");
const { stickerMenuRevision } = await import("../../../../packages/cache/workers/aiChat/stickers/menu");
const { STICKER_CATALOG_RETRY_INTERVAL_MS } = await import("../../../../packages/consts/aiChat/stickers");
const previousConfig: ReturnType<typeof getStickerConfig> = getStickerConfig();

afterEach((): void => { adoptStickerConfig(previousConfig); });

/**
 * 五个替身都是模块级共享的，`mockReset()` 同时清调用记录与 `mockImplementationOnce`
 * 排队的实现，每条用例开始前统一复位，避免执行顺序不同导致排队替身串到下一条用例。
 *
 * 目录状态（catalogs/dirtyPacks/failedEntries/generatingPacks）不在这里清：
 * 每条用例都用各自独立的包名与 uid 自行 `hydrate` 播种，彼此不可见。
 */
beforeEach(() => {
  getStickerSetMock.mockReset();
  getStickerSetMock.mockImplementation(async (_pack: string): Promise<any> => null);
  describeMediaMock.mockReset();
  describeMediaMock.mockImplementation(async (..._args: unknown[]): Promise<string | null> => null);
  describeMediaForStickerCatalogMock.mockReset();
  describeMediaForStickerCatalogMock.mockImplementation(
    async (..._args: unknown[]): Promise<AiTextResult> => retryableFailure
  );
  generateTextMock.mockReset();
  generateTextMock.mockImplementation(
    async (..._args: unknown[]): Promise<AiTextResult> => generatedText("一包默认简介")
  );
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (..._args: unknown[]): Promise<void> => {});
});

function sticker(fileUniqueId: string, emoji: string): any {
  return { file_id: `id-${fileUniqueId}`, file_unique_id: fileUniqueId, emoji, is_animated: false, is_video: false };
}

/** 快照在管线上以序列化 JSON 文本流转（见 types/stickers/protocol.ts），hydrate 吃的
 *  是 pack -> JSON 字符串。 */
function persisted(pack: string, entries: Record<string, { emoji: string; description: string }>, summary: string | null = null): Map<string, string> {
  return new Map([[pack, JSON.stringify({ version: 1, entries, summary, savedAt: 0 })]]);
}

test.each(["complete", "removed", "abort"] as const)("部分目录已有简介时到期维护补缺，结果=%s", async (outcome) => {
  const pack: string = `partial_${outcome}`;
  const good: string = `${pack}_good`;
  const bad: string = `${pack}_bad`;
  let now: number = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation((): number => now);
  const previous: AbortController = aiChatWorkerAbortController.current;
  const controller: AbortController = new AbortController();
  aiChatWorkerAbortController.current = controller;
  stickerCatalogRetryState.lastAttemptAt = 0;
  try {
    getStickerSetMock.mockResolvedValue({ title: pack, stickers: [sticker(good, "👍"), sticker(bad, "👎")] });
    describeMediaForStickerCatalogMock.mockResolvedValueOnce(generatedText("成功项")).mockResolvedValueOnce(requestFailure);
    await generatePackCatalog(pack);
    expect(getPackSummary(pack)).toBe("一包默认简介");
    const retryAt: number = failedEntries.get(pack)!.get(bad)!;
    now = retryAt - 1;
    retryIncompleteStickerCatalogs([pack], now);
    await drainStickerCatalogTasks();
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);
    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledTimes(2);
    now = retryAt;
    const result = Promise.withResolvers<AiTextResult>();
    if (outcome === "removed") getStickerSetMock.mockResolvedValue({ title: pack, stickers: [sticker(good, "👍")] });
    else describeMediaForStickerCatalogMock.mockImplementationOnce((): Promise<AiTextResult> => result.promise);
    retryIncompleteStickerCatalogs([pack], now);
    retryIncompleteStickerCatalogs([pack], now + STICKER_CATALOG_RETRY_INTERVAL_MS);
    await Promise.resolve();
    if (outcome === "abort") controller.abort();
    result.resolve(generatedText("补齐项"));
    await drainStickerCatalogTasks();
    expect(getStickerSetMock).toHaveBeenCalledTimes(2);
    expect(generatingPacks.has(pack)).toBe(false);
    expect(getCatalogEntry(good)?.description).toBe("成功项");
    if (outcome === "complete") {
      expect(getCatalogEntry(bad)?.description).toBe("补齐项");
      expect(failedEntries.has(pack)).toBe(false);
      now += STICKER_CATALOG_RETRY_INTERVAL_MS * 2;
      retryIncompleteStickerCatalogs([pack], now);
      await drainStickerCatalogTasks();
      expect(getStickerSetMock).toHaveBeenCalledTimes(2);
      expect(describeMediaForStickerCatalogMock).toHaveBeenCalledTimes(3);
    } else {
      expect(getCatalogEntry(bad)).toBeUndefined();
      if (outcome === "removed") expect(failedEntries.has(pack)).toBe(false);
    }
  } finally {
    clock.mockRestore();
    aiChatWorkerAbortController.current = previous;
  }
});

describe("aiChat/ai/stickers/catalog generatePackCatalog 对账", () => {
  test("停机排空等待后台目录任务结算，不会在最终快照之后继续改写", async () => {
    let releaseLookup: (() => void) | undefined;
    getStickerSetMock.mockImplementationOnce((): Promise<any> =>
      new Promise<any>((resolve: (value: null) => void): void => {
        releaseLookup = (): void => resolve(null);
      }));

    ensureStickerCatalogs(["pack_drain"]);
    let drained: boolean = false;
    const drain: Promise<void> = drainStickerCatalogTasks().then((): void => { drained = true; });
    await Promise.resolve();

    expect(generatingPacks.has("pack_drain")).toBeTrue();
    expect(drained).toBeFalse();
    releaseLookup!();
    await drain;

    expect(drained).toBeTrue();
    expect(generatingPacks.has("pack_drain")).toBeFalse();
  });

  test("Worker 取消会中止目录重采样退避且不写失败负缓存", async () => {
    const controller: AbortController = new AbortController();
    let markSleeping: (() => void) | null = null;
    const sleeping: Promise<void> = new Promise<void>((resolve: () => void): void => {
      markSleeping = resolve;
    });
    sleepMock.mockImplementationOnce((...args: unknown[]): Promise<void> => {
      const signal: AbortSignal | undefined = args[1] as AbortSignal | undefined;
      if (signal === undefined) return Promise.reject(new Error("missing abort signal"));
      const activeSignal: AbortSignal = signal;
      markSleeping?.();
      return new Promise<void>((
        _resolve: (value: void | PromiseLike<void>) => void,
        reject: (reason?: unknown) => void
      ): void => {
        activeSignal.addEventListener("abort", (): void => reject(activeSignal.reason), { once: true });
      });
    });
    getStickerSetMock.mockImplementationOnce(async () => ({
      title: "取消包",
      stickers: [sticker("cancelled-uid", "🛑")],
    }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => retryableFailure);

    const task: Promise<void> = generatePackCatalog("pack_cancelled", controller.signal);
    await sleeping;
    controller.abort(new DOMException("test cancellation", "AbortError"));
    await task;

    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledTimes(1);
    expect(failedEntries.has("pack_cancelled")).toBeFalse();
    expect(getCatalogEntry("cancelled-uid")).toBeUndefined();
  });
  test("hydrate 遇到坏快照时整批 fail-closed，不接管前面的合法包", () => {
    expect((): void => hydrateStickerCatalogs(new Map([
      ["pack_before_bad", JSON.stringify({
        version: 1,
        entries: { "pack_before_bad_uid": { emoji: "👍", description: "合法描述" } },
        summary: null,
        savedAt: 0,
      })],
      ["pack_bad_shape", JSON.stringify({ version: 1, entries: null })],
    ]))).toThrow(
      "Sticker catalog hydrate payload for pack pack_bad_shape: $ must be " +
      "the current version=1 sticker catalog schema."
    );

    expect(getCatalogEntry("pack_before_bad_uid")).toBeUndefined();
    expect(getPackSummary("pack_bad_shape")).toBeUndefined();
    expect(getCatalogEntry("pack_bad_shape_uid")).toBeUndefined();
  });

  test("线上有、目录没有的补：生成描述并写入，随后生成整包简介", async () => {
    transientDescriptionCache.set("new-uid", Promise.resolve("临时旧描述"));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "新包", stickers: [sticker("new-uid", "😂")] }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => generatedText("一只猫大笑"));
    generateTextMock.mockImplementationOnce(async () => generatedText("一包猫猫表情"));

    await generatePackCatalog("pack_add");

    expect(getCatalogEntry("new-uid")).toEqual({ emoji: "😂", description: "一只猫大笑" });
    expect(getPackSummary("pack_add")).toBe("一包猫猫表情");
    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledWith("id-new-uid", expect.any(AbortSignal));
    expect(describeMediaMock).not.toHaveBeenCalled();
    expect(transientDescriptionCache.has("new-uid")).toBe(false);
  });

  test("目录有、线上已经没有的剪：不再出现在线上列表的条目被删除", async () => {
    hydrateStickerCatalogs(persisted("pack_prune", { "stale-uid": { emoji: "😭", description: "已经不存在的贴纸" } }));
    expect(getCatalogEntry("stale-uid")).toBeDefined();
    transientDescriptionCache.set("stale-uid", Promise.resolve("不应复活的旧描述"));

    getStickerSetMock.mockImplementationOnce(async () => ({ title: "空包", stickers: [] }));

    await generatePackCatalog("pack_prune");

    expect(getCatalogEntry("stale-uid")).toBeUndefined();
    expect(transientDescriptionCache.has("stale-uid")).toBe(false);
  });

  test("查线上失败（getStickerSet 返回 null）：不补也不剪，保留现状", async () => {
    hydrateStickerCatalogs(persisted("pack_fail", { "kept-uid": { emoji: "😴", description: "保留的贴纸" } }, "保留的简介"));

    getStickerSetMock.mockImplementationOnce(async () => null);

    await generatePackCatalog("pack_fail");

    expect(getCatalogEntry("kept-uid")).toEqual({ emoji: "😴", description: "保留的贴纸" });
    expect(getPackSummary("pack_fail")).toBe("保留的简介");
  });

  test("同一枚贴纸已有描述则不重复生成（不调用 describeMedia）", async () => {
    hydrateStickerCatalogs(persisted("pack_skip", { "existing-uid": { emoji: "👍", description: "已经生成过" } }, "已有简介"));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "老包", stickers: [sticker("existing-uid", "👍")] }));

    await generatePackCatalog("pack_skip");

    expect(describeMediaForStickerCatalogMock).not.toHaveBeenCalled();
    expect(getCatalogEntry("existing-uid")).toEqual({ emoji: "👍", description: "已经生成过" });
  });

  test("条目没变化且已有整包简介：不重新生成简介", async () => {
    hydrateStickerCatalogs(persisted("pack_summary_keep", { "uid-a": { emoji: "👍", description: "描述A" } }, "旧简介"));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "稳定包", stickers: [sticker("uid-a", "👍")] }));

    await generatePackCatalog("pack_summary_keep");

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(getPackSummary("pack_summary_keep")).toBe("旧简介");
  });

  test("条目没变化但还没有简介：补生成简介", async () => {
    hydrateStickerCatalogs(persisted("pack_summary_backfill", { "uid-b": { emoji: "👍", description: "描述B" } }, null));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "待补简介包", stickers: [sticker("uid-b", "👍")] }));
    generateTextMock.mockImplementationOnce(async () => generatedText("补出来的简介"));

    await generatePackCatalog("pack_summary_backfill");

    expect(getPackSummary("pack_summary_backfill")).toBe("补出来的简介");
  });

  test("简介生成失败且退避重试用尽（1 + 3 次）：保留旧简介，不清掉", async () => {
    hydrateStickerCatalogs(persisted("pack_summary_fail", { "uid-c": { emoji: "👍", description: "描述C" } }, "旧简介仍在"));
    // 包内容有变化（新增一枚），简介要重生成，但首次和三次重试全部失败。
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "变动包", stickers: [sticker("uid-c", "👍"), sticker("uid-d", "😂")] }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => generatedText("新贴纸描述"));
    generateTextMock
      .mockImplementationOnce(async () => retryableFailure)
      .mockImplementationOnce(async () => retryableFailure)
      .mockImplementationOnce(async () => retryableFailure)
      .mockImplementationOnce(async () => retryableFailure);

    await generatePackCatalog("pack_summary_fail");

    expect(getCatalogEntry("uid-d")).toEqual({ emoji: "😂", description: "新贴纸描述" });
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    expect(getPackSummary("pack_summary_fail")).toBe("旧简介仍在");
  });

  test("SDK 已耗尽请求重试时不再套目录业务重试", async () => {
    hydrateStickerCatalogs(persisted("pack_request_fail", { "uid-e": { emoji: "👍", description: "描述E" } }, "旧简介保留"));
    getStickerSetMock.mockImplementationOnce(async () => ({
      title: "请求失败包",
      stickers: [sticker("uid-e", "👍"), sticker("uid-f", "😂")],
    }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => generatedText("新描述F"));
    generateTextMock.mockImplementationOnce(async () => requestFailure);

    await generatePackCatalog("pack_request_fail");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(getPackSummary("pack_request_fail")).toBe("旧简介保留");
  });

  test("单枚解析与简介生成瞬时失败：退避重试内成功即正常写入", async () => {
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "抖动包", stickers: [sticker("retry-uid", "😂")] }));
    describeMediaForStickerCatalogMock
      .mockImplementationOnce(async () => retryableFailure)
      .mockImplementationOnce(async () => generatedText("第二次成功的描述"));
    generateTextMock
      .mockImplementationOnce(async () => retryableFailure)
      .mockImplementationOnce(async () => generatedText("重试出的简介"));

    await generatePackCatalog("pack_retry");

    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledTimes(2);
    expect(getCatalogEntry("retry-uid")).toEqual({ emoji: "😂", description: "第二次成功的描述" });
    expect(getPackSummary("pack_retry")).toBe("重试出的简介");
  });

  test("目录还没建起来的包在维护节拍上按间隔重试，建好之后不再打扰", async () => {
    getStickerSetMock.mockImplementation(async () => null);
    stickerCatalogRetryState.lastAttemptAt = 0;

    retryIncompleteStickerCatalogs(["pack_periodic"], 10_000);
    await Bun.sleep(1);
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);

    // 间隔没到不重复打请求。
    retryIncompleteStickerCatalogs(["pack_periodic"], 10_001);
    await Bun.sleep(1);
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);

    // 间隔到了就再试一次，这次拉到了。
    getStickerSetMock.mockImplementation(async () => ({ title: "补回来的包", stickers: [sticker("late-uid", "😂")] }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => generatedText("补出来的描述"));
    generateTextMock.mockImplementationOnce(async () => generatedText("补出来的简介"));
    retryIncompleteStickerCatalogs(["pack_periodic"], 10_000 + STICKER_CATALOG_RETRY_INTERVAL_MS);
    await Bun.sleep(1);
    expect(getStickerSetMock).toHaveBeenCalledTimes(2);
    expect(getCatalogEntry("late-uid")).toEqual({ emoji: "😂", description: "补出来的描述" });

    // 目录与简介都齐了：此后每一轮都是一次判空，不再发请求。
    retryIncompleteStickerCatalogs(["pack_periodic"], 10_000 + STICKER_CATALOG_RETRY_INTERVAL_MS * 2);
    await Bun.sleep(1);
    expect(getStickerSetMock).toHaveBeenCalledTimes(2);
  });

  test("整包描述全失败不永久闩死：失败负缓存到期后对账真的会重描", async () => {
    getStickerSetMock.mockImplementation(async () => ({ title: "闩死包", stickers: [sticker("latch-uid", "😂")] }));
    describeMediaForStickerCatalogMock.mockImplementation(async () => retryableFailure);

    await generatePackCatalog("pack_latch");
    // 1 次 + 3 次退避重试全部失败，这一枚进失败桶，整包目录仍为空。
    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledTimes(4);
    expect(getCatalogEntry("latch-uid")).toBeUndefined();

    // 负缓存生效期内不重复打视觉调用。
    await generatePackCatalog("pack_latch");
    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledTimes(4);

    // 到期之后必须真的再试一次，并把目录补起来。
    failedEntries.get("pack_latch")!.set("latch-uid", Date.now() - 1);
    describeMediaForStickerCatalogMock.mockImplementation(async () => generatedText("终于描述出来了"));
    generateTextMock.mockImplementationOnce(async () => generatedText("自愈出来的简介"));

    await generatePackCatalog("pack_latch");

    expect(getCatalogEntry("latch-uid")).toEqual({ emoji: "😂", description: "终于描述出来了" });
    expect(getPackSummary("pack_latch")).toBe("自愈出来的简介");
    expect(failedEntries.has("pack_latch")).toBe(false);
  });
});

describe("aiChat/ai/stickers/catalog pruneStickerCatalogs 按白名单剪枝", () => {
  test.each([false, true])("移出的在途目录在任务结算及上报后释放（拉取成功=%s）", async (succeeded: boolean): Promise<void> => {
    const pack: string = "settling_pack";
    adoptStickerConfig({ packs: [pack] });
    hydrateStickerCatalogs(persisted(pack, { "settling-uid": { emoji: "🙂", description: "待对账" } }));
    const deferred: PromiseWithResolvers<any> = Promise.withResolvers<any>();
    getStickerSetMock.mockImplementationOnce((): Promise<any> => deferred.promise);
    ensureStickerCatalogs([pack]);
    adoptStickerConfig({ packs: [] });
    pruneStickerCatalogs([]);
    expect(catalogs.has(pack)).toBeTrue();
    deferred.resolve(succeeded ? { stickers: [] } : null);
    await drainStickerCatalogTasks();
    expect(generatingPacks.has(pack)).toBeFalse();
    expect(catalogs.has(pack)).toBe(succeeded);
    expect(dirtyPacks.has(pack)).toBe(succeeded);
    const posted: string[] = [];
    flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => { posted.push(event.pack); });
    expect(posted.includes(pack)).toBe(succeeded);
    expect(catalogs.has(pack)).toBeFalse();
    expect(dirtyPacks.has(pack)).toBeFalse();
  });

  /** 当前目录里除指定包以外的全部包名，作为白名单传给 pruneStickerCatalogs，
   *  使剪枝只作用于本用例的包，不影响同文件其它用例播下的状态。 */
  function whitelistExcept(excluded: string): string[] {
    return [...catalogs.keys()].filter((pack: string): boolean => pack !== excluded);
  }

  test("已下架包先交回待上报快照，再剪掉目录、简介与失败记录", () => {
    hydrateStickerCatalogs(persisted("prune_stale", { "prune-stale-uid": { emoji: "😭", description: "下架包" } }, "下架包简介"));
    hydrateStickerCatalogs(persisted("prune_kept", { "prune-kept-uid": { emoji: "😂", description: "留用包" } }, "留用包简介"));
    dirtyPacks.add("prune_stale");
    dirtyPacks.add("prune_kept");
    failedEntries.set("prune_stale", new Map([["prune-stale-uid", 0]]));
    const revision: number = stickerMenuRevision.current;

    pruneStickerCatalogs(whitelistExcept("prune_stale"));
    expect(catalogs.has("prune_stale")).toBeTrue();
    expect(dirtyPacks.has("prune_stale")).toBeTrue();
    adoptStickerConfig({ packs: whitelistExcept("prune_stale") });
    const posted: string[] = [];
    flushDirtyStickerCatalogs((event: AiStickerCatalogEvent): void => { posted.push(event.pack); });
    expect(posted).toContain("prune_stale");

    expect(catalogs.has("prune_stale")).toBe(false);
    expect(getCatalogEntry("prune-stale-uid")).toBeUndefined();
    expect(getPackSummary("prune_stale")).toBeUndefined();
    expect(failedEntries.has("prune_stale")).toBe(false);
    expect(dirtyPacks.has("prune_stale")).toBe(false);
    expect(stickerMenuRevision.current).toBeGreaterThan(revision);
    // 仍在白名单里的包保留已上报的目录。
    expect(getCatalogEntry("prune-kept-uid")).toEqual({ emoji: "😂", description: "留用包" });
    expect(getPackSummary("prune_kept")).toBe("留用包简介");
    expect(dirtyPacks.has("prune_kept")).toBe(false);
    dirtyPacks.delete("prune_kept");
  });

  test("正在生成目录的包跳过，生成结算之后才剪", () => {
    hydrateStickerCatalogs(persisted("prune_inflight", { "prune-inflight-uid": { emoji: "👍", description: "在途包" } }));
    const whitelist: string[] = whitelistExcept("prune_inflight");
    generatingPacks.set("prune_inflight", Promise.resolve());

    // 在途任务还在往这几张表里写，此刻剪了会被它补回来。
    pruneStickerCatalogs(whitelist);
    expect(getCatalogEntry("prune-inflight-uid")).toEqual({ emoji: "👍", description: "在途包" });

    generatingPacks.delete("prune_inflight");
    pruneStickerCatalogs(whitelist);
    expect(getCatalogEntry("prune-inflight-uid")).toBeUndefined();
  });

  test("白名单覆盖当前全部包时不剪也不失效菜单", () => {
    hydrateStickerCatalogs(persisted("prune_stable", { "prune-stable-uid": { emoji: "🙂", description: "稳定包" } }));
    const revision: number = stickerMenuRevision.current;

    pruneStickerCatalogs([...catalogs.keys()]);

    expect(getCatalogEntry("prune-stable-uid")).toEqual({ emoji: "🙂", description: "稳定包" });
    expect(stickerMenuRevision.current).toBe(revision);
  });
});
