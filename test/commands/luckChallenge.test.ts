import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * mock.module 必须在任何真实 import 之前调用（静态 import 会被提升，所以下面
 * 全部用动态 import 拿到被 mock 过的版本）：commands/luckChallenge.ts 与
 * infra/logger.ts 都会 import infra/diskIO.ts，而该文件在模块顶层就会
 * `new Worker(...)` 指向项目真实的 memory/ 目录——单测里绝不能让它真的跑起来
 * （会跟正在跑的 bot 进程并发读写同一批文件）。
 */
const postDiskIOMock = mock((..._args: unknown[]): void => {});
const onDiskIORespawnMock = mock((..._args: unknown[]): void => {});
const relayLogMessageMock = mock((..._args: unknown[]): void => {});

mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: postDiskIOMock,
  onDiskIORespawn: onDiskIORespawnMock,
  relayLogMessage: relayLogMessageMock,
}));

const luckChallenge = await import("../../src/commands/luckChallenge");
const cache = await import("../../src/cache/luckChallenge");
const { LUCK_TIERS } = await import("../../src/consts/luckChallenge");

function makeInlineCtx(userId: number, query: string) {
  const results: any[] = [];
  return {
    inlineQuery: { from: { id: userId, username: undefined, first_name: "Test" }, query },
    answerInlineQuery: async (r: any[]): Promise<void> => {
      results.push(...r);
    },
    results,
  };
}

function bodyTextOf(result: any): string {
  return result.input_message_content.message_text;
}

describe("/luck_challenge 预览 -> 选中确认 -> 落盘 全链路", () => {
  beforeEach(() => {
    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    cache.pendingLuckRenderIndex.clear();
    cache.recentCallTimestamps.length = 0;
    cache.luckCacheState.dayKey = "";
    postDiskIOMock.mockClear();
  });

  test("不带文本：选中「未卜先知」结果 -> confirmLuckDraw 命中 pendingLuckRenderIndex -> postDiskIO 落盘", async () => {
    const ctx = makeInlineCtx(111, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(2);

    const fortuneBody: string = bodyTextOf(ctx.results[0]);
    luckChallenge.confirmLuckDraw(111, fortuneBody);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    const msg: any = postDiskIOMock.mock.calls[0]![0];
    expect(msg.type).toBe("luckDraw");
    expect(msg.key).toBe("111");
    expect(cache.dailyLuckCache.has("111")).toBe(true);
  });

  test("不带文本：选中「概率论」结果（同一把 key）也能确认落盘", async () => {
    const ctx = makeInlineCtx(222, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const probabilityBody: string = bodyTextOf(ctx.results[1]);
    luckChallenge.confirmLuckDraw(222, probabilityBody);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "222" });
  });

  test("带文本（所求事项）：选中结果 -> 用带冒号的 key 落盘", async () => {
    const ctx = makeInlineCtx(333, "今天适合表白吗");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(1);

    const body: string = bodyTextOf(ctx.results[0]);
    luckChallenge.confirmLuckDraw(333, body);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "333:今天适合表白吗" });
  });

  test("同一天多个不同 key（多用户 / 同用户不同所求事项）各自独立落盘一次", async () => {
    const ctxA = makeInlineCtx(1, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxA as any);
    luckChallenge.confirmLuckDraw(1, bodyTextOf(ctxA.results[0]));

    const ctxB = makeInlineCtx(2, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxB as any);
    luckChallenge.confirmLuckDraw(2, bodyTextOf(ctxB.results[0]));

    const ctxC = makeInlineCtx(1, "工作运");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxC as any);
    luckChallenge.confirmLuckDraw(1, bodyTextOf(ctxC.results[0]));

    expect(postDiskIOMock).toHaveBeenCalledTimes(3);
    const keys: string[] = postDiskIOMock.mock.calls.map((c: any) => c[0].key);
    expect(new Set(keys)).toEqual(new Set(["1", "2", "1:工作运"]));
  });

  test("只预览不选中：不落盘（confirmLuckDraw 从未被调用）", async () => {
    const ctx = makeInlineCtx(444, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(postDiskIOMock).not.toHaveBeenCalled();
    expect(cache.dailyLuckCache.size).toBe(0);
  });

  test("重复选中/重复送达同一条 via_bot 消息：只落盘一次（幂等）", async () => {
    const ctx = makeInlineCtx(555, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);
    luckChallenge.confirmLuckDraw(555, body);
    luckChallenge.confirmLuckDraw(555, body);
    luckChallenge.confirmLuckDraw(555, body);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
  });

  test("重新预览同一把 key 后再选中：同一天不会二次落盘/二次滚动", async () => {
    const ctx1 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx1 as any);
    luckChallenge.confirmLuckDraw(666, bodyTextOf(ctx1.results[0]));
    expect(postDiskIOMock).toHaveBeenCalledTimes(1);

    // 已确认之后用户又 @机器人 打了一遍字（重新触发 inline_query 预览）
    const ctx2 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx2 as any);
    expect(bodyTextOf(ctx2.results[0])).toBe(bodyTextOf(ctx1.results[0]));
    luckChallenge.confirmLuckDraw(666, bodyTextOf(ctx2.results[0]));

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
  });

  test("restoreLuckCache 灌回的记录，用户当天再预览拿到的是同一个结果（不会重新滚动）", async () => {
    const today = (await import("../../src/libs/time")).getTokyoDateKey();
    const tier = LUCK_TIERS[0]!;
    const restoredPercent: number = tier.fortunePercentRange[0];
    luckChallenge.restoreLuckCache({
      day: today,
      entries: new Map([["777", { label: tier.label, fortunePercent: restoredPercent }]]),
    });

    const ctx = makeInlineCtx(777, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(bodyTextOf(ctx.results[0])).toContain(tier.label);
    expect(bodyTextOf(ctx.results[0])).toContain(tier.comment);

    // 已经是确认过的结果，预览不应该重新调用 postDiskIO
    expect(postDiskIOMock).not.toHaveBeenCalled();
  });
});
