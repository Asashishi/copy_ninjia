import { afterEach, beforeEach, expect, test } from "bun:test";
import { transientDescriptionCache } from "../../../packages/cache/workers/aiChat/imageDescription";
import { MEDIA_DESCRIPTION_CACHE_MAX } from "../../../packages/consts/aiChat/media";

beforeEach(() => transientDescriptionCache.clear());
afterEach(() => transientDescriptionCache.clear());

test("媒体描述 LRU 按 MEDIA_DESCRIPTION_CACHE_MAX 定容，满载命中续期，溢出只淘汰最久未使用项", () => {
  const description: Promise<string | null> = Promise.resolve("媒体描述");
  for (let index: number = 0; index < MEDIA_DESCRIPTION_CACHE_MAX; index++) {
    transientDescriptionCache.set(String(index), description);
  }
  expect(transientDescriptionCache.size).toBe(MEDIA_DESCRIPTION_CACHE_MAX);
  expect(transientDescriptionCache.get("0")).toBe(description);
  transientDescriptionCache.set("overflow", description);
  expect(transientDescriptionCache.size).toBe(MEDIA_DESCRIPTION_CACHE_MAX);
  expect(transientDescriptionCache.has("0")).toBe(true);
  expect(transientDescriptionCache.has("1")).toBe(false);
  expect(transientDescriptionCache.get("overflow")).toBe(description);

  for (let index: number = 0; index < MEDIA_DESCRIPTION_CACHE_MAX * 3; index++) {
    transientDescriptionCache.set(`later-${index}`, description);
    expect(transientDescriptionCache.get("0")).toBe(description);
    expect(transientDescriptionCache.size).toBe(MEDIA_DESCRIPTION_CACHE_MAX);
  }
  transientDescriptionCache.clear();
  expect(transientDescriptionCache.size).toBe(0);
  expect(transientDescriptionCache.get("0")).toBeUndefined();
});
