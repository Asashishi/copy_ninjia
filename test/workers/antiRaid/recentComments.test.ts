import { beforeEach, describe, expect, test } from "bun:test";
import { COMMENT_JOIN_CORRELATE_MS, RECENT_COMMENT_CACHE_MAX } from "../../../src/consts/antiRaid";
import { recentChannelComments } from "../../../src/cache/antiRaidWorker";
import { rememberRecentComment, sweepRecentComments, takeRecentComment } from "../../../src/workers/antiRaid/recentComments";

beforeEach(() => recentChannelComments.clear());

describe("recent channel comment cache", () => {
  test("记录可被消费一次，过期项即使 sweeper 尚未运行也不会被误用", () => {
    rememberRecentComment(-1001, 42, 10, false, 1_000);
    expect(takeRecentComment(-1001, 42, 1_000 + COMMENT_JOIN_CORRELATE_MS - 1)).toEqual({
      messageId: 10,
      repliesToChannelPost: false,
      observedAt: 1_000,
    });
    expect(takeRecentComment(-1001, 42, 2_000)).toBeUndefined();

    rememberRecentComment(-1001, 42, 11, false, 3_000);
    expect(takeRecentComment(-1001, 42, 3_000 + COMMENT_JOIN_CORRELATE_MS)).toBeUndefined();
    expect(recentChannelComments).toHaveLength(0);
  });

  test("同 key 更新保留有效期内的直属评论豁免证明，但不继承已过期证明", () => {
    rememberRecentComment(-1001, 42, 10, true, 1_000);
    rememberRecentComment(-1001, 42, 11, false, 2_000);
    expect(takeRecentComment(-1001, 42, 2_000)).toMatchObject({ messageId: 11, repliesToChannelPost: true, observedAt: 2_000 });

    rememberRecentComment(-1001, 42, 12, true, 3_000);
    rememberRecentComment(-1001, 42, 13, false, 3_000 + COMMENT_JOIN_CORRELATE_MS);
    expect(takeRecentComment(-1001, 42, 3_000 + COMMENT_JOIN_CORRELATE_MS)).toMatchObject({
      messageId: 13,
      repliesToChannelPost: false,
    });
  });

  test("统一 sweeper 批量删除到期项并保留仍有效项", () => {
    rememberRecentComment(-1001, 1, 10, false, 1_000);
    rememberRecentComment(-1001, 2, 11, false, 2_000);
    expect(sweepRecentComments(1_000 + COMMENT_JOIN_CORRELATE_MS)).toBe(1);
    expect([...recentChannelComments.keys()]).toEqual(["-1001:2"]);
  });

  test("达到全局容量时淘汰 observedAt 最早项，容量始终不越界", () => {
    for (let userId = 1; userId <= RECENT_COMMENT_CACHE_MAX; userId++) {
      rememberRecentComment(-1001, userId, userId, false, 10_000 + userId);
    }
    expect(recentChannelComments).toHaveLength(RECENT_COMMENT_CACHE_MAX);

    rememberRecentComment(-2002, 99_999, 99_999, false, 20_000);
    expect(recentChannelComments).toHaveLength(RECENT_COMMENT_CACHE_MAX);
    expect(recentChannelComments.has("-1001:1")).toBeFalse();
    expect(recentChannelComments.has("-2002:99999")).toBeTrue();
  });
});
