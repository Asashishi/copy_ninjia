/**
 * 每群生歌冷却：15 分钟窗口、superAdmin 旁路、令牌回滚与周期清扫。
 *
 * 与图片冷却**状态独立**这一条要专门守住：共用一张表会让「刚生过图所以十五分钟内
 * 不能生歌」这种谁都解释不清的耦合出现。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SONG_GENERATION_COOLDOWN_MS } from "../../../packages/consts/aiChat/songGeneration";
import { IMAGE_GENERATION_COOLDOWN_MS } from "../../../packages/consts/aiChat/imageGeneration";
import {
  claimImageGeneration,
  getImageGenerationAvailability,
  resetImageGenerationCache,
} from "../../../packages/cache/workers/aiChat/imageGeneration";
import {
  claimSongGeneration,
  getSongGenerationAvailability,
  releaseSongGenerationClaim,
  resetSongGenerationCache,
  songGenerationClaimTimes,
  sweepSongGenerationCache,
} from "../../../packages/cache/workers/aiChat/songGeneration";

afterEach(() => {
  resetSongGenerationCache();
  resetImageGenerationCache();
});

describe("每群生歌冷却", () => {
  test("冷却口径就是需求写死的 15 分钟", () => {
    expect(SONG_GENERATION_COOLDOWN_MS).toBe(15 * 60 * 1_000);
  });

  test("各群独立计时，并在冷却边界重新放行", () => {
    expect(claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 0 }).allowed).toBeTrue();
    expect(claimSongGeneration({ chatId: -1002, bypassCooldown: false, now: 10 }).allowed).toBeTrue();
    expect(claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: SONG_GENERATION_COOLDOWN_MS - 1 })).toEqual({
      allowed: false,
      retryAfterMs: 1,
    });
    expect(claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: SONG_GENERATION_COOLDOWN_MS }).allowed).toBeTrue();
  });

  test("只读可用性查询与原子占位使用同一套冷却判断", () => {
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false, now: 0 })).toEqual({ allowed: true });
    claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false, now: 1_000 })).toEqual({
      allowed: false,
      retryAfterMs: SONG_GENERATION_COOLDOWN_MS - 1_000,
    });
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: true, now: 1_000 })).toEqual({ allowed: true });
  });

  test("superAdmin 旁路既不受已有冷却影响，也不延长普通用户冷却", () => {
    claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 100 });

    expect(claimSongGeneration({ chatId: -1001, bypassCooldown: true, now: 200 })).toEqual({ allowed: true, token: null });
    expect(claimSongGeneration({ chatId: -1003, bypassCooldown: true, now: 200 })).toEqual({ allowed: true, token: null });
    expect(songGenerationClaimTimes.has(-1003)).toBe(false);
    expect(claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 300 })).toEqual({
      allowed: false,
      retryAfterMs: SONG_GENERATION_COOLDOWN_MS - 200,
    });
  });

  test("生图与生歌各占一张表：生过图不会连带锁住生歌，反之亦然", () => {
    claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false, now: 0 })).toEqual({ allowed: true });

    claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    // 生歌冷却比生图长，这一刻生图早已解冻而生歌仍在窗口内。
    expect(getImageGenerationAvailability({
      chatId: -1001,
      bypassCooldown: false,
      now: IMAGE_GENERATION_COOLDOWN_MS,
    })).toEqual({ allowed: true });
    expect(getSongGenerationAvailability({
      chatId: -1001,
      bypassCooldown: false,
      now: IMAGE_GENERATION_COOLDOWN_MS,
    }).allowed).toBeFalse();
  });

  test("维护清扫只删除已过期条目，并清掉时钟回拨落到未来的那些", () => {
    claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    claimSongGeneration({ chatId: -1002, bypassCooldown: false, now: SONG_GENERATION_COOLDOWN_MS / 2 });
    sweepSongGenerationCache(SONG_GENERATION_COOLDOWN_MS);
    expect(songGenerationClaimTimes.has(-1001)).toBe(false);
    expect(songGenerationClaimTimes.has(-1002)).toBe(true);

    claimSongGeneration({ chatId: -1004, bypassCooldown: false, now: 10_000_000 });
    sweepSongGenerationCache(SONG_GENERATION_COOLDOWN_MS);
    expect(songGenerationClaimTimes.has(-1004)).toBe(false);
  });

  test("只有当前令牌能回滚占位，迟到旧请求不能删除后来建立的新冷却", () => {
    const first = claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    if (!first.allowed) throw new Error("expected first claim to succeed");
    expect(releaseSongGenerationClaim(-1001, first.token)).toBeTrue();
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false, now: 1 })).toEqual({ allowed: true });

    const stale = claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 10 });
    if (!stale.allowed) throw new Error("expected stale claim to succeed");
    sweepSongGenerationCache(10 + SONG_GENERATION_COOLDOWN_MS);
    const current = claimSongGeneration({
      chatId: -1001,
      bypassCooldown: false,
      now: 10 + SONG_GENERATION_COOLDOWN_MS,
    });
    if (!current.allowed) throw new Error("expected current claim to succeed");

    expect(releaseSongGenerationClaim(-1001, stale.token)).toBeFalse();
    expect(getSongGenerationAvailability({
      chatId: -1001,
      bypassCooldown: false,
      now: 11 + SONG_GENERATION_COOLDOWN_MS,
    }).allowed).toBeFalse();
    expect(releaseSongGenerationClaim(-1001, current.token)).toBeTrue();
    // superAdmin 的 null 令牌不代表任何占位，不能拿它撤销别人的冷却。
    expect(releaseSongGenerationClaim(-1001, null)).toBeFalse();
  });
});
