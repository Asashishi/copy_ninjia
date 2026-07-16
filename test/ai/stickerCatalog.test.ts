import { describe, expect, mock, test } from "bun:test";

/**
 * ai/stickerCatalog.ts 经 infra/logger -> infra/diskIO，后者在模块顶层就会
 * `new Worker(...)`：单测里绝不能让它真的跑起来（理由同 test/commands/
 * luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 * ai/stickerSets.ts（真实拉取贴纸集合）、ai/imageDescription.ts（真实调
 * 视觉模型）与 ai/gemini.ts（整包简介生成走的文本模型）也一并 mock 掉，
 * 换成测试可控的假实现——本文件只关心 generatePackCatalog 的对账逻辑
 * （补/剪/失败时按兵不动/整包简介的生成时机），不关心真实网络调用是否
 * 成功（那部分由手动跑过的真实模型调用验证过）。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const getStickerSetMock = mock(async (_pack: string): Promise<any> => null);
const describeMediaMock = mock(async (..._args: unknown[]): Promise<string | null> => null);
const describeMediaForStickerCatalogMock = mock(async (..._args: unknown[]): Promise<string | null> => null);
// 整包简介生成：默认返回一条固定简介文本，可按用例改写/断言调用次数。
const requestGeminiResponseMock = mock(async (..._args: unknown[]): Promise<any> => ({
  candidates: [{ content: { parts: [{ text: "一包默认简介" }] } }],
}));

mock.module("../../src/ai/stickerSets", () => ({
  getStickerSet: getStickerSetMock,
  pickStickerVisionSource: (sticker: any) => ({ fileId: `${sticker.file_id}`, fileUniqueId: sticker.file_unique_id }),
}));
mock.module("../../src/ai/imageDescription", () => ({
  describeMedia: describeMediaMock,
  describeMediaForStickerCatalog: describeMediaForStickerCatalogMock,
}));
const realGemini = await import("../../src/ai/gemini");
mock.module("../../src/ai/gemini", () => ({ ...realGemini, requestGeminiResponse: requestGeminiResponseMock }));

const { generatePackCatalog, getCatalogEntry, getPackSummary, hydrateStickerCatalogs } = await import("../../src/ai/stickerCatalog");
const { transientDescriptionCache } = await import("../../src/cache/imageDescription");

function sticker(fileUniqueId: string, emoji: string): any {
  return { file_id: `id-${fileUniqueId}`, file_unique_id: fileUniqueId, emoji, is_animated: false, is_video: false };
}

/** 快照在管线上以序列化 JSON 文本流转（见 types/aiChat.ts），hydrate 吃的
 *  是 pack -> JSON 字符串。 */
function persisted(pack: string, entries: Record<string, { emoji: string; description: string }>, summary: string | null = null): Map<string, string> {
  return new Map([[pack, JSON.stringify({ version: 1, entries, summary, savedAt: 0 })]]);
}

describe("ai/stickerCatalog generatePackCatalog 对账", () => {
  test("线上有、目录没有的补：生成描述并写入，随后生成整包简介", async () => {
    transientDescriptionCache.set("new-uid", Promise.resolve("临时旧描述"));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "新包", stickers: [sticker("new-uid", "😂")] }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => "一只猫大笑");
    requestGeminiResponseMock.mockImplementationOnce(async () => ({ candidates: [{ content: { parts: [{ text: "一包猫猫表情" }] } }] }));

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
    requestGeminiResponseMock.mockClear();

    await generatePackCatalog("pack_summary_keep");

    expect(requestGeminiResponseMock).not.toHaveBeenCalled();
    expect(getPackSummary("pack_summary_keep")).toBe("旧简介");
  });

  test("条目没变化但还没有简介（旧格式文件恢复）：补生成简介", async () => {
    hydrateStickerCatalogs(persisted("pack_summary_backfill", { "uid-b": { emoji: "👍", description: "描述B" } }, null));
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "旧格式包", stickers: [sticker("uid-b", "👍")] }));
    requestGeminiResponseMock.mockImplementationOnce(async () => ({ candidates: [{ content: { parts: [{ text: "补出来的简介" }] } }] }));

    await generatePackCatalog("pack_summary_backfill");

    expect(getPackSummary("pack_summary_backfill")).toBe("补出来的简介");
  });

  test("简介生成失败：保留旧简介，不清掉", async () => {
    hydrateStickerCatalogs(persisted("pack_summary_fail", { "uid-c": { emoji: "👍", description: "描述C" } }, "旧简介仍在"));
    // 包内容有变化（新增一枚），简介要重生成，但这次生成失败。
    getStickerSetMock.mockImplementationOnce(async () => ({ title: "变动包", stickers: [sticker("uid-c", "👍"), sticker("uid-d", "😂")] }));
    describeMediaForStickerCatalogMock.mockImplementationOnce(async () => "新贴纸描述");
    requestGeminiResponseMock.mockImplementationOnce(async () => null);

    await generatePackCatalog("pack_summary_fail");

    expect(getCatalogEntry("uid-d")).toEqual({ emoji: "😂", description: "新贴纸描述" });
    expect(getPackSummary("pack_summary_fail")).toBe("旧简介仍在");
  });
});
