import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * mock.module 必须在任何真实 import 之前调用（静态 import 会被提升，所以下面
 * 全部用动态 import 拿到被 mock 过的版本）：commands/luckChallenge.ts 依赖的
 * 模块可能间接 import infra/diskIO.ts，而该文件在模块顶层就会
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

describe("/luck_challenge 预览 -> 选中确认 -> 进当日内存缓存 全链路", () => {
  beforeEach(() => {
    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    cache.pendingLuckRenderIndex.clear();
    cache.recentCallTimestamps.length = 0;
    cache.luckCacheState.dayKey = "";
  });

  test("不带文本：选中「未卜先知」结果 -> confirmLuckDraw 命中 pendingLuckRenderIndex -> 转正进 dailyLuckCache", async () => {
    const ctx = makeInlineCtx(111, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(2);

    const fortuneBody: string = bodyTextOf(ctx.results[0]);
    luckChallenge.confirmLuckDraw(fortuneBody);

    expect(cache.dailyLuckCache.has("111")).toBe(true);
    expect(cache.pendingLuckDraws.has("111")).toBe(false);
  });

  test("不带文本：选中「概率论」结果（同一把 key）也能确认", async () => {
    const ctx = makeInlineCtx(222, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const probabilityBody: string = bodyTextOf(ctx.results[1]);
    luckChallenge.confirmLuckDraw(probabilityBody);

    expect(cache.dailyLuckCache.has("222")).toBe(true);
  });

  test("带文本（所求事项）：选中结果 -> 用带冒号的 key 转正", async () => {
    const ctx = makeInlineCtx(333, "今天适合表白吗");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(1);

    const body: string = bodyTextOf(ctx.results[0]);
    luckChallenge.confirmLuckDraw(body);

    expect(cache.dailyLuckCache.has("333:今天适合表白吗")).toBe(true);
  });

  test("同一天多个不同 key（多用户 / 同用户不同所求事项）各自独立转正", async () => {
    const ctxA = makeInlineCtx(1, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxA as any);
    luckChallenge.confirmLuckDraw(bodyTextOf(ctxA.results[0]));

    const ctxB = makeInlineCtx(2, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxB as any);
    luckChallenge.confirmLuckDraw(bodyTextOf(ctxB.results[0]));

    const ctxC = makeInlineCtx(1, "工作运");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxC as any);
    luckChallenge.confirmLuckDraw(bodyTextOf(ctxC.results[0]));

    expect(new Set(cache.dailyLuckCache.keys())).toEqual(new Set(["1", "2", "1:工作运"]));
  });

  test("以频道马甲/匿名管理员身份发出（消息 from 带不回真实 uid）：仍能按文本认领", async () => {
    // 回归线上事故：inline 预览永远是真人账号发起，但用户以马甲身份把结果
    // 发进群时，via_bot 消息的 from 被 Telegram 换成 Channel_Bot/匿名马甲，
    // 旧实现的 `${userId} ${文本}` 索引永远查不上——确认只能靠文本本身。
    const ctx = makeInlineCtx(888, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);

    // 调用方（index.ts 的网关前中间件）只把消息文本传进来，不含（也拿不到）真实 uid
    luckChallenge.confirmLuckDraw(body);

    expect(cache.dailyLuckCache.has("888")).toBe(true);
  });

  test("chosen_inline_result 主路：机器人不在场的聊天里选中也能确认", async () => {
    const ctx = makeInlineCtx(999, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    // Telegram 直推的选中回执：带真实 uid 与查询词，与结果发到哪个聊天无关
    luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune", from: { id: 999 }, query: "" },
    } as any);

    expect(cache.dailyLuckCache.has("999")).toBe(true);
  });

  test("chosen_inline_result：带所求事项的选中按「uid:文本」key 确认", async () => {
    const ctx = makeInlineCtx(1000, "今天买彩票吗");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune-text", from: { id: 1000 }, query: "今天买彩票吗" },
    } as any);

    expect(cache.dailyLuckCache.has("1000:今天买彩票吗")).toBe(true);
  });

  test("chosen_inline_result 与文本认领兜底先后到达：幂等，结果不变", async () => {
    const ctx = makeInlineCtx(1001, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);

    luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune", from: { id: 1001 }, query: "" },
    } as any);
    const confirmed = cache.dailyLuckCache.get("1001");
    luckChallenge.confirmLuckDraw(body);

    expect(cache.dailyLuckCache.size).toBe(1);
    expect(cache.dailyLuckCache.get("1001")).toBe(confirmed!);
  });

  test("chosen_inline_result：选中限流提示不占今日缓存", async () => {
    luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-rate-limited", from: { id: 1002 }, query: "" },
    } as any);
    expect(cache.dailyLuckCache.size).toBe(0);
  });

  test("只预览不选中：不算测过（confirmLuckDraw 从未被调用）", async () => {
    const ctx = makeInlineCtx(444, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(cache.dailyLuckCache.size).toBe(0);
    expect(cache.pendingLuckDraws.has("444")).toBe(true);
  });

  test("重复送达同一条结果消息（如多份转发副本）：幂等，结果不变", async () => {
    const ctx = makeInlineCtx(555, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);
    luckChallenge.confirmLuckDraw(body);
    const confirmed = cache.dailyLuckCache.get("555");
    luckChallenge.confirmLuckDraw(body);
    luckChallenge.confirmLuckDraw(body);

    expect(cache.dailyLuckCache.size).toBe(1);
    expect(cache.dailyLuckCache.get("555")).toBe(confirmed!);
  });

  test("重新预览同一把 key 后再选中：同一天不会二次滚动", async () => {
    const ctx1 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx1 as any);
    luckChallenge.confirmLuckDraw(bodyTextOf(ctx1.results[0]));
    const confirmed = cache.dailyLuckCache.get("666");

    // 已确认之后用户又 @机器人 打了一遍字（重新触发 inline_query 预览）
    const ctx2 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx2 as any);
    expect(bodyTextOf(ctx2.results[0])).toBe(bodyTextOf(ctx1.results[0]));
    luckChallenge.confirmLuckDraw(bodyTextOf(ctx2.results[0]));

    expect(cache.dailyLuckCache.get("666")).toBe(confirmed!);
  });
});
