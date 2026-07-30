import { describe, expect, mock, test } from "bun:test";

const { getStickerSet } = await import("../../../packages/ai/stickers/sets");
const { failedPacks, inflightStickerSets, stickerSetCache } = await import("../../../packages/cache/workers/aiChat/stickers/sets");

describe("ai/stickers/sets getStickerSet 失败恢复", () => {
  test("瞬时失败只在负缓存窗口内拦截，过期后同一进程会重新请求并恢复", async () => {
    const pack = "retryable_pack";
    const expected: any = { name: pack, title: "Retryable", sticker_type: "regular", stickers: [] };
    let calls = 0;
    const api = {
      getStickerSet: mock(async (): Promise<any> => {
        calls++;
        if (calls === 1) throw new Error("temporary network failure");
        return expected;
      }),
    };

    try {
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(calls).toBe(1);
      expect(failedPacks.get(pack)).toBeGreaterThan(Date.now());

      // 负缓存仍有效时不重复轰 Telegram。
      expect(await getStickerSet(pack, api)).toBeNull();
      expect(calls).toBe(1);

      // 模拟窗口到期：无需重启进程即可重新请求并转为正缓存。
      failedPacks.set(pack, Date.now() - 1);
      expect(await getStickerSet(pack, api)).toBe(expected);
      expect(calls).toBe(2);
      expect(failedPacks.has(pack)).toBe(false);
      expect(stickerSetCache.get(pack)).toBe(expected);
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
    }
  });

  test("缓存未命中时并发调用合并成一次请求，settle 后不留在途登记", async () => {
    const pack = "coalesced_pack";
    const expected: any = { name: pack, title: "Coalesced", sticker_type: "regular", stickers: [] };
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const api = {
      getStickerSet: mock(async (): Promise<any> => {
        calls++;
        await gate;
        return expected;
      }),
    };

    try {
      const first = getStickerSet(pack, api);
      const second = getStickerSet(pack, api);
      expect(inflightStickerSets.has(pack)).toBe(true);
      release();
      expect(await first).toBe(expected);
      expect(await second).toBe(expected);
      expect(calls).toBe(1);
      expect(inflightStickerSets.has(pack)).toBe(false);
    } finally {
      failedPacks.delete(pack);
      stickerSetCache.delete(pack);
    }
  });
});
