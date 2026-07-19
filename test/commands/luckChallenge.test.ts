import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * mock.module 必须在任何真实 import 之前调用（静态 import 会被提升，所以下面
 * 全部用动态 import 拿到被 mock 过的版本）。diskIO 模块导入已无副作用，
 * 这里仍替换其进程级单例桥，才能精确断言落盘消息并模拟 Worker 重建。
 */
const postDiskIOMock = mock((..._args: unknown[]): void => {});
const onDiskIORespawnMock = mock((..._args: unknown[]): void => {});
const relayLogMessageMock = mock((..._args: unknown[]): void => {});

mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: postDiskIOMock,
  onDiskIORespawn: onDiskIORespawnMock,
  relayLogMessage: relayLogMessageMock,
  ensureLuckReceiptSecret: async (day: string) => ({
    version: 1 as const,
    day,
    key: Buffer.alloc(32, 7).toString("base64url"),
  }),
}));

const luckChallenge = await import("../../src/commands/luckChallenge");
const cache = await import("../../src/cache/luckChallenge");
const { LUCK_TIERS, RATE_LIMIT_MAX_CALLS_PER_WINDOW } = await import("../../src/consts/luckChallenge");
const { getTokyoDateKey } = await import("../../src/libs/time");
const TEST_SECRET = { version: 1 as const, day: getTokyoDateKey(), key: Buffer.alloc(32, 7).toString("base64url") };

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

function visibleBodyOf(result: any): string {
  return bodyTextOf(result).split("\n").slice(0, -1).join("\n");
}

describe("/luck_challenge 预览 -> 选中确认 -> 落盘 全链路", () => {
  beforeEach(() => {
    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    cache.recentCallTimestamps.length = 0;
    luckChallenge.restoreLuckState(TEST_SECRET, null);
    postDiskIOMock.mockClear();
  });

  test("不带文本：带签名回执的结果现身后转正并 postDiskIO 落盘", async () => {
    const ctx = makeInlineCtx(111, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(2);

    const fortuneBody: string = bodyTextOf(ctx.results[0]);
    expect(fortuneBody.split("\n").at(-1)?.startsWith("防伪标记: luck:v1:")).toBe(true);
    const spoiler = ctx.results[0].input_message_content.entities[0];
    expect(fortuneBody.slice(spoiler.offset, spoiler.offset + spoiler.length).startsWith("luck:v1:")).toBe(true);
    await luckChallenge.confirmLuckDraw(fortuneBody);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    const msg: any = postDiskIOMock.mock.calls[0]![0];
    expect(msg.type).toBe("luckDraw");
    expect(msg.key).toBe("111");
    expect(cache.dailyLuckCache.has("111")).toBe(true);
    expect(cache.pendingLuckDraws.has("111")).toBe(false);
  });

  test("当日升级前已发出的旧版无「防伪标记」前缀回执仍能确认", async () => {
    const ctx = makeInlineCtx(112, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const lines: string[] = bodyTextOf(ctx.results[0]).split("\n");
    const prefixedReceipt: string = lines.pop()!;
    const legacyReceipt: string = prefixedReceipt.slice("防伪标记: ".length);

    await luckChallenge.confirmLuckDraw(`${lines.join("\n")}\n${legacyReceipt}`);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "112" });
  });

  test("不带文本：选中「概率论」结果（同一把 key）也能确认落盘", async () => {
    const ctx = makeInlineCtx(222, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const probabilityBody: string = bodyTextOf(ctx.results[1]);
    await luckChallenge.confirmLuckDraw(probabilityBody);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "222" });
    expect(cache.dailyLuckCache.has("222")).toBe(true);
  });

  test("带文本（所求事项）：选中结果 -> 用带冒号的 key 落盘", async () => {
    const ctx = makeInlineCtx(333, "今天适合表白吗");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(1);

    const body: string = bodyTextOf(ctx.results[0]);
    await luckChallenge.confirmLuckDraw(body);

    const expectedKey: string = luckChallenge.luckCacheKey(333, "今天适合表白吗");
    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: expectedKey });
    expect(expectedKey.startsWith("333:")).toBe(true);
    expect(cache.dailyLuckCache.has(expectedKey)).toBe(true);
  });

  test("带文本：同款问题按钮只展示前 4 个字加 ...，但仍携带完整文本", async () => {
    const question = "谷歌没发 3.5 pro 我要死了呜啊啊啊啊";
    const ctx = makeInlineCtx(8603940412, question);
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    const sameQuestionButton = ctx.results[0]!.reply_markup.inline_keyboard[0]![1]!;
    expect(sameQuestionButton.text).toBe("谷歌没发...");
    expect(sameQuestionButton.switch_inline_query_current_chat).toBe(question);
  });

  test("同一天多个不同 key（多用户 / 同用户不同所求事项）各自独立落盘一次", async () => {
    const ctxA = makeInlineCtx(1, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxA as any);
    await luckChallenge.confirmLuckDraw(bodyTextOf(ctxA.results[0]));

    const ctxB = makeInlineCtx(2, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxB as any);
    await luckChallenge.confirmLuckDraw(bodyTextOf(ctxB.results[0]));

    const ctxC = makeInlineCtx(1, "工作运");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxC as any);
    await luckChallenge.confirmLuckDraw(bodyTextOf(ctxC.results[0]));

    expect(postDiskIOMock).toHaveBeenCalledTimes(3);
    const expectedKeys = new Set([
      luckChallenge.luckCacheKey(1, undefined),
      luckChallenge.luckCacheKey(2, undefined),
      luckChallenge.luckCacheKey(1, "工作运"),
    ]);
    const keys: string[] = postDiskIOMock.mock.calls.map((c: any) => c[0].key);
    expect(new Set(keys)).toEqual(expectedKeys);
    expect(new Set(cache.dailyLuckCache.keys())).toEqual(expectedKeys);
  });

  test("以频道马甲/匿名管理员身份发出（消息 from 带不回真实 uid）：仍能按签名回执认领落盘", async () => {
    // 回归线上事故：inline 预览永远是真人账号发起，但用户以马甲身份把结果
    // 发进群时，via_bot 消息的 from 被 Telegram 换成 Channel_Bot/匿名马甲，
    // 旧实现的 `${userId} ${文本}` 索引永远查不上——确认只能靠文本本身。
    const ctx = makeInlineCtx(888, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);

    // 调用方（index.ts 的网关前中间件）只把消息文本传进来，不含（也拿不到）真实 uid
    await luckChallenge.confirmLuckDraw(body);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "888" });
    expect(cache.dailyLuckCache.has("888")).toBe(true);
  });

  test("两个用户有独立自描述回执，可分别准确确认", async () => {
    const first = makeInlineCtx(881, "");
    const second = makeInlineCtx(882, "");
    await luckChallenge.handleLuckChallengeInlineQuery(first as any);
    await luckChallenge.handleLuckChallengeInlineQuery(second as any);
    const firstSignedBody: string = bodyTextOf(first.results[0]);
    const secondSignedBody: string = bodyTextOf(second.results[0]);
    expect(secondSignedBody).not.toBe(firstSignedBody);

    await luckChallenge.confirmLuckDraw(firstSignedBody);
    expect(cache.dailyLuckCache.has("881")).toBe(true);
    expect(cache.dailyLuckCache.has("882")).toBe(false);
    await luckChallenge.confirmLuckDraw(secondSignedBody);
    expect(cache.dailyLuckCache.has("882")).toBe(true);
    expect(postDiskIOMock).toHaveBeenCalledTimes(2);
  });

  test("展示正文和伪造回执都不能替 pending 抽签确认", async () => {
    const ctx = makeInlineCtx(883, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const signedBody: string = bodyTextOf(ctx.results[0]);
    const visibleBody: string = visibleBodyOf(ctx.results[0]);

    await luckChallenge.confirmLuckDraw(visibleBody);
    await luckChallenge.confirmLuckDraw(`${visibleBody}\n防伪标记: luck:v1:${TEST_SECRET.day}:MTIz.${"B".repeat(43)}`);
    expect(cache.dailyLuckCache.has("883")).toBe(false);
    expect(postDiskIOMock).not.toHaveBeenCalled();

    await luckChallenge.confirmLuckDraw(signedBody);
    expect(cache.dailyLuckCache.has("883")).toBe(true);
  });

  test("chosen_inline_result 主路：机器人不在场的聊天里选中也能确认落盘", async () => {
    const ctx = makeInlineCtx(999, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    // Telegram 直推的选中回执：带真实 uid 与查询词，与结果发到哪个聊天无关
    await luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune", from: { id: 999 }, query: "" },
    } as any);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "999" });
    expect(cache.dailyLuckCache.has("999")).toBe(true);
  });

  test("chosen_inline_result：带所求事项的选中按「uid:文本」key 确认", async () => {
    const ctx = makeInlineCtx(1000, "今天买彩票吗");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    await luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune-text", from: { id: 1000 }, query: "今天买彩票吗" },
    } as any);

    expect(cache.dailyLuckCache.has(luckChallenge.luckCacheKey(1000, "今天买彩票吗"))).toBe(true);
  });

  test("chosen_inline_result 与签名回执兜底先后到达：幂等，只落盘一次", async () => {
    const ctx = makeInlineCtx(1001, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);

    await luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune", from: { id: 1001 }, query: "" },
    } as any);
    const confirmed = cache.dailyLuckCache.get("1001");
    await luckChallenge.confirmLuckDraw(body);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(cache.dailyLuckCache.size).toBe(1);
    expect(cache.dailyLuckCache.get("1001")).toBe(confirmed!);
  });

  test("chosen_inline_result：选中限流提示不占今日缓存、不落盘", async () => {
    await luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-rate-limited", from: { id: 1002 }, query: "" },
    } as any);
    expect(postDiskIOMock).not.toHaveBeenCalled();
    expect(cache.dailyLuckCache.size).toBe(0);
  });

  test("全局滑动窗口放行配置上限次数，下一次返回限流结果", async () => {
    for (let index: number = 0; index < RATE_LIMIT_MAX_CALLS_PER_WINDOW; index++) {
      const ctx = makeInlineCtx(10_000 + index, "");
      await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
      expect(ctx.results[0]?.id).not.toBe("luck-rate-limited");
    }

    const limitedCtx = makeInlineCtx(20_000, "");
    await luckChallenge.handleLuckChallengeInlineQuery(limitedCtx as any);
    expect(limitedCtx.results[0]?.id).toBe("luck-rate-limited");
  });

  test("只预览不选中：不算测过、不落盘（confirmLuckDraw 从未被调用）", async () => {
    const ctx = makeInlineCtx(444, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(postDiskIOMock).not.toHaveBeenCalled();
    expect(cache.dailyLuckCache.size).toBe(0);
    expect(cache.pendingLuckDraws.has("444")).toBe(true);
  });

  test("同日同密钥下 pending 被淘汰后重新预览仍得到完全相同结果", async () => {
    const first = makeInlineCtx(445, "重启稳定性");
    await luckChallenge.handleLuckChallengeInlineQuery(first as any);
    const firstBody: string = bodyTextOf(first.results[0]);
    cache.pendingLuckDraws.clear();

    const second = makeInlineCtx(445, "重启稳定性");
    await luckChallenge.handleLuckChallengeInlineQuery(second as any);
    expect(bodyTextOf(second.results[0])).toBe(firstBody);
  });

  test("预览后进程重启，消息回执仍可重建结果并转正", async () => {
    const ctx = makeInlineCtx(446, "重启后确认");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);

    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    luckChallenge.restoreLuckState(TEST_SECRET, null);
    await luckChallenge.confirmLuckDraw(body);

    const key: string = luckChallenge.luckCacheKey(446, "重启后确认");
    expect(cache.dailyLuckCache.has(key)).toBe(true);
    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
  });

  test("预览后进程重启，chosen_inline_result 也按 uid 与查询重建同一结果", async () => {
    const ctx = makeInlineCtx(447, "主路重启确认");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const key: string = luckChallenge.luckCacheKey(447, "主路重启确认");
    const preview = cache.pendingLuckDraws.get(key);

    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    luckChallenge.restoreLuckState(TEST_SECRET, null);
    await luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune-text", from: { id: 447 }, query: "主路重启确认" },
    } as any);

    expect(cache.dailyLuckCache.get(key)).toEqual(preview);
    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
  });

  test("重复送达同一条结果消息（如多份转发副本）：幂等，只落盘一次", async () => {
    const ctx = makeInlineCtx(555, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const body: string = bodyTextOf(ctx.results[0]);
    await luckChallenge.confirmLuckDraw(body);
    const confirmed = cache.dailyLuckCache.get("555");
    await luckChallenge.confirmLuckDraw(body);
    await luckChallenge.confirmLuckDraw(body);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(cache.dailyLuckCache.size).toBe(1);
    expect(cache.dailyLuckCache.get("555")).toBe(confirmed!);
  });

  test("重新预览同一把 key 后再选中：同一天不会二次落盘/二次滚动", async () => {
    const ctx1 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx1 as any);
    await luckChallenge.confirmLuckDraw(bodyTextOf(ctx1.results[0]));
    const confirmed = cache.dailyLuckCache.get("666");
    expect(postDiskIOMock).toHaveBeenCalledTimes(1);

    // 已确认之后用户又 @机器人 打了一遍字（重新触发 inline_query 预览）
    const ctx2 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx2 as any);
    expect(visibleBodyOf(ctx2.results[0])).toBe(visibleBodyOf(ctx1.results[0]));
    await luckChallenge.confirmLuckDraw(bodyTextOf(ctx2.results[0]));

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(cache.dailyLuckCache.get("666")).toBe(confirmed!);
  });

  test("restoreLuckState 灌回的记录，用户当天再预览拿到的是同一个结果（不会重新滚动）", async () => {
    const today = getTokyoDateKey();
    const tier = LUCK_TIERS[0]!;
    const restoredPercent: number = tier.fortunePercentRange[0];
    luckChallenge.restoreLuckState(TEST_SECRET, {
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
