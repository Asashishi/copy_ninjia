import { beforeEach, describe, expect, mock, test } from "bun:test";
import { settleTestBatch } from "../../../libs/helpers";

/**
 * 贴纸包菜单的记忆化（packages/aiChat/ai/tools/stickers.ts 的 buildStickerPackMenu）。
 *
 * 菜单的两个输入——贴纸集合缓存与画面描述目录——都是无 TTL 的进程内缓存，稳态
 * 下根本不变，而 createReplyToolset 每轮回复都要一份（每群最多 5 轮并发）。
 */
const getStickerSetMock = mock(async (_pack: string): Promise<any> => null);
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

// aiChat/ai/tools/stickers.ts 从领域入口 `../stickers` 取 getStickerSet，而那个入口是
// `export *`：只替换 sets.ts 会让入口少掉其余导出，因此连同入口一起透传。
const realSets = { ...(await import("../../../../packages/aiChat/ai/stickers/sets")) };
const realStickers = { ...(await import("../../../../packages/aiChat/ai/stickers")) };
mock.module("../../../../packages/aiChat/ai/stickers/sets", () => ({
  ...realSets,
  getStickerSet: getStickerSetMock,
}));
mock.module("../../../../packages/aiChat/ai/stickers", () => ({
  ...realStickers,
  getStickerSet: getStickerSetMock,
}));
mock.module("../../../../packages/config/stickers", () => ({
  getStickerConfig: (): { packs: readonly string[] } => ({ packs: ["pack_a"] }),
}));

const { buildStickerPackMenu } = await import("../../../../packages/aiChat/ai/tools/stickers");
const { catalogs } = await import("../../../../packages/cache/workers/aiChat/stickers/catalog");
const {
  invalidateStickerMenu,
  stickerMenuCache,
  stickerMenuInflight,
  stickerMenuRevision,
} = await import("../../../../packages/cache/workers/aiChat/stickers/menu");
const { aiChatWorkerAbortController } = await import(
  "../../../../packages/cache/workers/aiChat/worker"
);

function sticker(fileUniqueId: string): any {
  return { file_id: `id-${fileUniqueId}`, file_unique_id: fileUniqueId, emoji: "😂", is_animated: false, is_video: false };
}

beforeEach(() => {
  getStickerSetMock.mockClear();
  loggerError.mockClear();
  getStickerSetMock.mockImplementation(async () => ({ title: "猫猫包", stickers: [sticker("a1")] }));
  catalogs.clear();
  catalogs.set("pack_a", new Map([["a1", { emoji: "😂", description: "一只猫大笑" }]]));
  stickerMenuCache.current = null;
  stickerMenuInflight.current = null;
  stickerMenuRevision.current = 0;
  aiChatWorkerAbortController.current = new AbortController();
});

describe("贴纸包菜单的记忆化", () => {
  test("输入没变时复用同一份菜单，不再重新拉取与重建", async () => {
    const first = await buildStickerPackMenu();
    expect(first).toHaveLength(1);
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);

    const second = await buildStickerPackMenu();

    // 同一份引用：稳态下每轮回复都重建等于反复丢弃并重新分配一份完全相同的
    // 数百对象结构，纯 GC 压力。
    expect(second).toBe(first);
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);
  });

  test("目录或贴纸集合变化后重建", async () => {
    const first = await buildStickerPackMenu();
    catalogs.get("pack_a")!.set("a2", { emoji: "😭", description: "一只猫哭泣" });
    getStickerSetMock.mockImplementation(async () => ({ title: "猫猫包", stickers: [sticker("a1"), sticker("a2")] }));
    invalidateStickerMenu();

    const second = await buildStickerPackMenu();

    expect(second).not.toBe(first);
    expect(second[0]!.stickers).toHaveLength(2);
    expect(getStickerSetMock).toHaveBeenCalledTimes(2);
  });

  test("冷启动时并发的几轮回复共用同一次构建", async () => {
    // createReplyToolset 每轮调用一次，一个群最多 5 轮并发；不合并的话冷启动
    // 那一刻会对每个包各打 5 次 getStickerSet。
    const [first, second, third] = await settleTestBatch([
      buildStickerPackMenu(),
      buildStickerPackMenu(),
      buildStickerPackMenu(),
    ]);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(getStickerSetMock).toHaveBeenCalledTimes(1);
  });

  test("防御性 rejection 按包名留痕，不把 allSettled 变成静默吞错", async () => {
    const failure: Error = new Error("unexpected sticker fetch rejection");
    getStickerSetMock.mockRejectedValueOnce(failure);

    expect(await buildStickerPackMenu()).toEqual([]);
    expect(loggerError).toHaveBeenCalledWith(
      "Unexpected sticker menu fetch rejection for pack \"pack_a\":",
      failure
    );
  });

  test("构建期间又失效时不落缓存，下一次取会重建", async () => {
    const pending = buildStickerPackMenu();
    invalidateStickerMenu();
    await pending;

    expect(stickerMenuCache.current).toBeNull();
    await buildStickerPackMenu();
    expect(getStickerSetMock).toHaveBeenCalledTimes(2);
  });

  test("一轮回复取消只停止自身等待，不中止共享菜单构建", async () => {
    let release!: () => void;
    const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    getStickerSetMock.mockImplementation(async (): Promise<any> => {
      await gate;
      return { title: "猫猫包", stickers: [sticker("a1")] };
    });
    const controller: AbortController = new AbortController();

    const cancelled: Promise<readonly any[]> = buildStickerPackMenu(controller.signal);
    const live: Promise<readonly any[]> = buildStickerPackMenu();
    expect(getStickerSetMock).toHaveBeenCalledWith(
      "pack_a",
      undefined,
      aiChatWorkerAbortController.current.signal
    );

    controller.abort(new DOMException("reply invalidated", "AbortError"));
    expect(await cancelled).toEqual([]);
    expect(aiChatWorkerAbortController.current.signal.aborted).toBeFalse();

    release();
    const menu: readonly any[] = await live;
    expect(menu).toHaveLength(1);
    expect(stickerMenuCache.current?.menu).toBe(menu);
  });
});
