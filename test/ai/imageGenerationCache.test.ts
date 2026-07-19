import { afterEach, describe, expect, test } from "bun:test";
import { IMAGE_GENERATION_COOLDOWN_MS } from "../../src/consts/aiChat/imageGeneration";
import {
  claimImageGeneration,
  getImageGenerationAvailability,
  imageGenerationClaimTimes,
  resetImageGenerationCache,
  sweepImageGenerationCache,
} from "../../src/cache/aiChat/imageGeneration";

afterEach(() => {
  resetImageGenerationCache();
});

describe("每群图片生成冷却", () => {
  test("各群独立计时，并在配置的冷却边界重新放行", () => {
    expect(claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 0 })).toEqual({ allowed: true });
    expect(claimImageGeneration({ chatId: -1002, bypassCooldown: false, now: 10 })).toEqual({ allowed: true });
    expect(claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: IMAGE_GENERATION_COOLDOWN_MS - 1 })).toEqual({
      allowed: false,
      retryAfterMs: 1,
    });
    expect(claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: IMAGE_GENERATION_COOLDOWN_MS })).toEqual({ allowed: true });
  });

  test("只读可用性查询与原子占位使用同一套冷却判断", () => {
    expect(getImageGenerationAvailability({ chatId: -1001, bypassCooldown: false, now: 0 })).toEqual({ allowed: true });
    claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    expect(getImageGenerationAvailability({ chatId: -1001, bypassCooldown: false, now: 1_000 })).toEqual({
      allowed: false,
      retryAfterMs: IMAGE_GENERATION_COOLDOWN_MS - 1_000,
    });
    expect(getImageGenerationAvailability({ chatId: -1001, bypassCooldown: true, now: 1_000 })).toEqual({ allowed: true });
  });

  test("superAdmin 旁路既不受已有冷却影响，也不延长普通用户冷却", () => {
    claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 100 });

    expect(claimImageGeneration({ chatId: -1001, bypassCooldown: true, now: 200 })).toEqual({ allowed: true });
    expect(claimImageGeneration({ chatId: -1003, bypassCooldown: true, now: 200 })).toEqual({ allowed: true });
    expect(imageGenerationClaimTimes.has(-1003)).toBe(false);
    expect(claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 300 })).toEqual({
      allowed: false,
      retryAfterMs: IMAGE_GENERATION_COOLDOWN_MS - 200,
    });
  });

  test("维护清扫只删除已过期条目", () => {
    claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    claimImageGeneration({ chatId: -1002, bypassCooldown: false, now: IMAGE_GENERATION_COOLDOWN_MS / 2 });

    sweepImageGenerationCache(IMAGE_GENERATION_COOLDOWN_MS);

    expect(imageGenerationClaimTimes.has(-1001)).toBe(false);
    expect(imageGenerationClaimTimes.has(-1002)).toBe(true);
  });

  test("系统时间回拨时覆盖或清除未来条目，不造成永久冷却与缓存滞留", () => {
    claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 10_000 });
    expect(claimImageGeneration({ chatId: -1001, bypassCooldown: false, now: 5_000 })).toEqual({ allowed: true });
    expect(imageGenerationClaimTimes.get(-1001)).toBe(5_000);

    claimImageGeneration({ chatId: -1002, bypassCooldown: false, now: 20_000 });
    sweepImageGenerationCache(6_000);
    expect(imageGenerationClaimTimes.has(-1001)).toBe(true);
    expect(imageGenerationClaimTimes.has(-1002)).toBe(false);
  });
});
