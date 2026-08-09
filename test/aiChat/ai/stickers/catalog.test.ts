import { describe, expect, mock, test } from "bun:test";
import type { AiTextResult } from "../../../../packages/types/aiChat/provider";

function generatedText(text: string): AiTextResult {
  return { ok: true, text };
}

const retryableFailure: AiTextResult = { ok: false, retryable: true };
const requestFailure: AiTextResult = { ok: false, retryable: false };

/**
 * aiChat/ai/stickers/sets.ts（真实拉取贴纸集合）、aiChat/ai/imageDescription.ts（真实调
 * 视觉模型）与 aiChat/provider.ts（整包简介生成走的文本模型）也一并 mock 掉，
 * 换成测试可控的假实现——本文件只关心 generatePackCatalog 的对账逻辑
 * （补/剪/失败时按兵不动/整包简介的生成时机），不关心真实网络调用是否
 * 成功（那部分由手动跑过的真实模型调用验证过）。
 */
const getStickerSetMock = mock(async (_pack: string): Promise<any> => null);
const describeMediaMock = mock(async (..._args: unknown[]): Promise<string | null> => null);
const describeMediaForStickerCatalogMock = mock(async (..._args: unknown[]): Promise<AiTextResult> => retryableFailure);
// 整包简介生成：默认返回一条固定简介文本，可按用例改写/断言调用次数。
const generateTextMock = mock(async (..._args: unknown[]): Promise<AiTextResult> => generatedText("一包默认简介"));

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
mock.module("../../../../packages/libs/sleep", () => ({ sleep: mock(async (_ms: number): Promise<void> => {}) }));
mock.module("../../../../packages/aiChat/provider", () => ({
  summaryAiProvider: () => ({ name: "google", generateText: generateTextMock }),
}));

const {
  drainStickerCatalogTasks,
  ensureStickerCatalogs,
  generatePackCatalog,
  getCatalogEntry,
  getPackSummary,
  hydrateStickerCatalogs,
  retryIncompleteStickerCatalogs,
} = await import("../../../../packages/aiChat/ai/stickers/catalog");
const { transientDescriptionCache } = await import("../../../../packages/cache/workers/aiChat/imageDescription");
const {
  failedEntries,
  generatingPacks,
  stickerCatalogRetryState,
} = await import("../../../../packages/cache/workers/aiChat/stickers/catalog");
const { STICKER_CATALOG_RETRY_INTERVAL_MS } = await import("../../../../packages/consts/aiChat/stickers");

function sticker(fileUniqueId: string, emoji: string): any {
  return { file_id: `id-${fileUniqueId}`, file_unique_id: fileUniqueId, emoji, is_animated: false, is_video: false };
}

/** 快照在管线上以序列化 JSON 文本流转（见 types/aiChat.ts），hydrate 吃的
 *  是 pack -> JSON 字符串。 */
function persisted(pack: string, entries: Record<string, { emoji: string; description: string }>, summary: string | null = null): Map<string, string> {
  return new Map([[pack, JSON.stringify({ version: 1, entries, summary, savedAt: 0 })]]);
}

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
  test("hydrate 遇到语法合法但形状错误的快照时只丢弃该包", () => {
    hydrateStickerCatalogs(new Map([["pack_bad_shape", JSON.stringify({ version: 1, entries: null })]]));

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
    expect(describeMediaForStickerCatalogMock).toHaveBeenCalledWith("id-new-uid");
    expect(describeMediaMock).not.toHaveBeenCalled();
    expect(transientDescriptionCache.has("new-uid")).toBe(false);
  });

  test("目录有、线上已经没有的剪：不再出现在线上列表的条目被删除", async () => {
    hydrateStickerCatalogs(persisted("pack_prune", { "stale-uid": { emoji: "😭", description: "已经不存在的贴纸" } }));
    expect(getCatalogEntry("stale-uid")).toBeDefined();
    transientDescriptionCache.set("stale-uid", Promise.resolve("不应复活的旧描述"));

    getStickerSetMock.mockImplementationOnce(async () => ({ title: "空包", stickers: [] })); // 线上这个包已经没有贴纸了

    await generatePackCatalog("pack_prune");

    expect(getCatalogEntry("stale-uid")).toBeUndefined();
    expect(transientDescriptionCache.has("stale-uid")).toBe(false);
  });

  test("查线上失败（getStickerSet 返回 null）：不补也不剪，保留现状", async () => {
    hydrateStickerCatalogs(persisted("pack_fail", { "kept-uid": { emoji: "😴", description: "保留的贴纸" } }, "保留的简介"));

    getStickerSetMock.mockImplementationOnce(async () => null); // 网络失败

    await generatePackCatalog("pack_fail");

    // 失败不该把已有描述铲掉——这是本次修复要守住的核心不变量。
    expect(getCatalogEntry("kept-uid")).toEqual({ emoji: "😴", description: "保留的贴纸" });
    expect(getPackSummary("pack_fail")).toBe("保留的简介");
  });

  test("同一枚贴纸已有描述则不重复生成（不调用 describeMedia）", async () => {
    hydrateStickerCatalogs(persisted("pack_skip", { "existing-uid": { emoji: "👍", description: "已经生成过" } }, "已有简介"));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "老包", stickers: [sticker("existing-uid", "👍")] }));
    describeMediaForStickerCatalogMock.mockClear();

    await generatePackCatalog("pack_skip");

    expect(describeMediaForStickerCatalogMock).not.toHaveBeenCalled();
    expect(getCatalogEntry("existing-uid")).toEqual({ emoji: "👍", description: "已经生成过" });
  });

  test("条目没变化且已有整包简介：不重新生成简介", async () => {
    hydrateStickerCatalogs(persisted("pack_summary_keep", { "uid-a": { emoji: "👍", description: "描述A" } }, "旧简介"));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "稳定包", stickers: [sticker("uid-a", "👍")] }));
    generateTextMock.mockClear();

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
    generateTextMock.mockClear();
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
    generateTextMock.mockClear();
    generateTextMock.mockImplementationOnce(async () => requestFailure);

    await generatePackCatalog("pack_request_fail");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(getPackSummary("pack_request_fail")).toBe("旧简介保留");
  });

  test("单枚解析与简介生成瞬时失败：退避重试内成功即正常写入", async () => {
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "抖动包", stickers: [sticker("retry-uid", "😂")] }));
    describeMediaForStickerCatalogMock.mockClear();
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
    // 生产路径上 ensureStickerCatalogs 只有 init 那一次调用，而拉贴纸集合失败
    // 是整包放弃的：一次几秒的网络抖动就能让 catalogs 永久为空，两个贴纸工具
    // 对所有回复返回 null，而 systemd 托管的进程可能几周都不重启。
    getStickerSetMock.mockClear();
    getStickerSetMock.mockImplementation(async () => null);
    stickerCatalogRetryState.lastAttemptAt = 0;

    retryIncompleteStickerCatalogs(["pack_periodic"], 10_000);
    await Bun.sleep(1);
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);

    // 间隔没到不重复打请求：包名配错这类永远好不了的情形下，每次重试都要跟着
    // 记一条错误日志。
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
    // 首次部署撞上一次视觉端点故障（配额耗尽/密钥刚轮换）时整包每一枚都失败。
    // 失败桶若是永久闩，retryIncompleteStickerCatalogs 每 5 分钟正确选中这个包也
    // 只会原地跳过每一枚，目录永远填不起来——两个贴纸工具对所有回复返回 null，
    // 而 systemd 托管的进程可以连跑几周。
    getStickerSetMock.mockImplementation(async () => ({ title: "闩死包", stickers: [sticker("latch-uid", "😂")] }));
    describeMediaForStickerCatalogMock.mockClear();
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
