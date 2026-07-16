import { describe, expect, mock, test } from "bun:test";

/**
 * ai/stickerCatalog.ts 经 infra/logger -> infra/diskIO，后者在模块顶层就会
 * `new Worker(...)`：单测里绝不能让它真的跑起来（理由同 test/commands/
 * luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 * ai/stickerSets.ts（真实拉取贴纸集合）与 ai/imageDescription.ts（真实
 * 调视觉模型）也一并 mock 掉，换成测试可控的假实现——本文件只关心
 * generatePackCatalog 的对账逻辑（补/剪/失败时按兵不动），不关心真实网络
 * 调用是否成功（那部分由手动跑过的真实 xAI 调用验证过）。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const getStickerSetMock = mock(async (_pack: string): Promise<any> => null);
const describeMediaMock = mock(async (..._args: unknown[]): Promise<string | null> => null);

mock.module("../../src/ai/stickerSets", () => ({
  getStickerSet: getStickerSetMock,
  pickStickerVisionSource: (sticker: any) => ({ fileId: `${sticker.file_id}`, fileUniqueId: sticker.file_unique_id }),
}));
mock.module("../../src/ai/imageDescription", () => ({
  describeMedia: describeMediaMock,
}));

const { generatePackCatalog, getCatalogEntry, hydrateStickerCatalogs } = await import("../../src/ai/stickerCatalog");

function sticker(fileUniqueId: string, emoji: string): any {
  return { file_id: `id-${fileUniqueId}`, file_unique_id: fileUniqueId, emoji, is_animated: false, is_video: false };
}

describe("ai/stickerCatalog generatePackCatalog 对账", () => {
  test("线上有、目录没有的补：生成描述并写入", async () => {
    getStickerSetMock.mockImplementationOnce(async () => ({ stickers: [sticker("new-uid", "😂")] }));
    describeMediaMock.mockImplementationOnce(async () => "一只猫大笑");

    await generatePackCatalog("pack_add");

    expect(getCatalogEntry("new-uid")).toEqual({ emoji: "😂", description: "一只猫大笑" });
  });

  test("目录有、线上已经没有的剪：不再出现在线上列表的条目被删除", async () => {
    hydrateStickerCatalogs(new Map([["pack_prune", { version: 1, entries: { "stale-uid": { emoji: "😭", description: "已经不存在的贴纸" } }, savedAt: 0 }]]));
    expect(getCatalogEntry("stale-uid")).toBeDefined();

    getStickerSetMock.mockImplementationOnce(async () => ({ stickers: [] })); // 线上这个包已经没有贴纸了

    await generatePackCatalog("pack_prune");

    expect(getCatalogEntry("stale-uid")).toBeUndefined();
  });

  test("查线上失败（getStickerSet 返回 null）：不补也不剪，保留现状", async () => {
    hydrateStickerCatalogs(new Map([["pack_fail", { version: 1, entries: { "kept-uid": { emoji: "😴", description: "保留的贴纸" } }, savedAt: 0 }]]));

    getStickerSetMock.mockImplementationOnce(async () => null); // 网络失败

    await generatePackCatalog("pack_fail");

    // 失败不该把已有描述铲掉——这是本次修复要守住的核心不变量。
    expect(getCatalogEntry("kept-uid")).toEqual({ emoji: "😴", description: "保留的贴纸" });
  });

  test("同一枚贴纸已有描述则不重复生成（不调用 describeMedia）", async () => {
    hydrateStickerCatalogs(new Map([["pack_skip", { version: 1, entries: { "existing-uid": { emoji: "👍", description: "已经生成过" } }, savedAt: 0 }]]));
    getStickerSetMock.mockImplementationOnce(async () => ({ stickers: [sticker("existing-uid", "👍")] }));
    describeMediaMock.mockClear();

    await generatePackCatalog("pack_skip");

    expect(describeMediaMock).not.toHaveBeenCalled();
    expect(getCatalogEntry("existing-uid")).toEqual({ emoji: "👍", description: "已经生成过" });
  });
});
