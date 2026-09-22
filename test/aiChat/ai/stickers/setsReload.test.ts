import { afterEach, expect, spyOn, test } from "bun:test";
import type { StickerSet } from "grammy/types";
import { getStickerSet } from "../../../../packages/aiChat/ai/stickers/sets";
import { failedPacks, inflightStickerSets, stickerSetCache } from "../../../../packages/cache/workers/aiChat/stickers/sets";
import { aiChatWorkerQuiescing } from "../../../../packages/cache/workers/aiChat/worker";
import { getStickerConfig, parseStickerConfig } from "../../../../packages/config/stickers";
import { MAX_CONFIGURED_STICKER_PACKS } from "../../../../packages/consts/aiChat/stickers";
import { logger } from "../../../../packages/infra/logger";
import { applyAiChatConfigReload } from "../../../../packages/workers/aiChat/configReload";

const previousConfig: ReturnType<typeof getStickerConfig> = getStickerConfig();
const previousQuiescing: boolean = aiChatWorkerQuiescing.current;
aiChatWorkerQuiescing.current = true;

function reload(packs: string[]): void {
  applyAiChatConfigReload({ type: "configReload", agent: undefined, mood: undefined, stickers: parseStickerConfig({ packs }) });
}

function stickerSet(pack: string): StickerSet {
  return { name: pack, title: pack, sticker_type: "regular", stickers: [] };
}

afterEach((): void => {
  reload([]);
  applyAiChatConfigReload({ type: "configReload", agent: undefined, mood: undefined, stickers: previousConfig });
  aiChatWorkerQuiescing.current = previousQuiescing;
});

test("连续轮换合法白名单后，正负缓存只保留当前包", async (): Promise<void> => {
  aiChatWorkerQuiescing.current = true;
  const errors: { mockRestore(): void } = spyOn(logger, "error").mockImplementation((): void => {});
  try {
    for (let generation: number = 0; generation < 40; generation++) {
      const packs: string[] = Array.from({ length: MAX_CONFIGURED_STICKER_PACKS }, (_, index: number): string => `pack_${generation}_${index}`);
      reload(packs);
      for (let index: number = 0; index < packs.length; index++) {
        const pack: string = packs[index]!;
        await getStickerSet(pack, {
          getStickerSet: async (): Promise<StickerSet> => {
            if (index % 2) throw new Error("Mock failure");
            return stickerSet(pack);
          },
        });
      }
      expect(stickerSetCache.size + failedPacks.size).toBe(MAX_CONFIGURED_STICKER_PACKS);
      expect([...stickerSetCache.keys(), ...failedPacks.keys()].every((pack: string): boolean => packs.includes(pack))).toBeTrue();
      expect(inflightStickerSets.size).toBe(0);
    }
  } finally { errors.mockRestore(); }
});

test.each([false, true])("移出配置后迟到的请求仍结算，但不回填缓存（失败=%s）", async (fails: boolean): Promise<void> => {
  aiChatWorkerQuiescing.current = true;
  reload(["late_pack"]);
  const deferred: PromiseWithResolvers<StickerSet> = Promise.withResolvers<StickerSet>();
  const errors: { mockRestore(): void } = spyOn(logger, "error").mockImplementation((): void => {});
  try {
    const waiting: Promise<StickerSet | null> = getStickerSet("late_pack", { getStickerSet: (): Promise<StickerSet> => deferred.promise });
    reload([]);
    if (fails) deferred.reject(new Error("Late failure"));
    else deferred.resolve(stickerSet("late_pack"));
    expect(await waiting).toEqual(fails ? null : stickerSet("late_pack"));
    expect(stickerSetCache.size).toBe(0);
    expect(failedPacks.size).toBe(0);
    expect(inflightStickerSets.size).toBe(0);
  } finally { errors.mockRestore(); }
});

test("移除后重新加入同包仍共享在途请求，完成后供当前白名单复用", async (): Promise<void> => {
  aiChatWorkerQuiescing.current = true;
  reload(["returning_pack"]);
  const deferred: PromiseWithResolvers<StickerSet> = Promise.withResolvers<StickerSet>();
  let calls: number = 0;
  const api: { getStickerSet(): Promise<StickerSet> } = { getStickerSet: (): Promise<StickerSet> => { calls++; return deferred.promise; } };
  const first: Promise<StickerSet | null> = getStickerSet("returning_pack", api);
  reload([]);
  reload(["returning_pack"]);
  const second: Promise<StickerSet | null> = getStickerSet("returning_pack", api);
  const expected: StickerSet = stickerSet("returning_pack");
  deferred.resolve(expected);
  expect(await first).toBe(expected);
  expect(await second).toBe(expected);
  expect(await getStickerSet("returning_pack", api)).toBe(expected);
  expect(calls).toBe(1);
});
