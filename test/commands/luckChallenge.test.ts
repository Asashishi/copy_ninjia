import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * mock.module 必须在任何真实 import 之前调用（静态 import 会被提升，所以下面
 * 全部用动态 import 拿到被 mock 过的版本）。diskIO 模块导入已无副作用，
 * 这里仍替换其进程级单例桥，才能精确断言落盘消息并模拟 Worker 重建。
 */
const postDiskIOMock = mock((..._args: unknown[]): void => {});
const onDiskIORespawnMock = mock((..._args: unknown[]): void => {});
const relayLogMessageMock = mock((..._args: unknown[]): void => {});
const logApiErrorMock = mock((..._args: unknown[]): void => {});
const loggerErrorMock = mock((..._args: unknown[]): void => {});
let ensureLuckReceiptSecretError: unknown = null;

const ensureLuckReceiptSecretMock = mock(async (day: string) => {
  if (ensureLuckReceiptSecretError !== null) throw ensureLuckReceiptSecretError;
  return {
    version: 1 as const,
    day,
    key: Buffer.alloc(32, 7).toString("base64url"),
  };
});

mock.module("../../packages/infra/telegram", () => ({
  logApiError: logApiErrorMock,
}));

mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: loggerErrorMock,
  },
}));

mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO: postDiskIOMock,
  onDiskIORespawn: onDiskIORespawnMock,
  relayLogMessage: relayLogMessageMock,
  ensureLuckReceiptSecret: ensureLuckReceiptSecretMock,
}));

// 跨东京零点专项测试用的日期开关：mockTodayOverride 为 null（默认与收尾）
// 时 getTokyoDateKey 走真实实现，其余测试完全不受影响。
// 两个坑（都是本 bun 版本 mock.module 的行为）决定了必须写成这个形状：
// 1. 真实模块必须先展开成普通对象快照再 mock——mock.module 之后，此前拿到的
//    模块命名空间引用会被追溯重绑定到 mock 本身，工厂里引用它会在加载期
//    死锁或调用期无限递归；普通对象持有的真实函数引用不受重绑定影响。
// 2. 对同一模块的 mock.module 二次注册不会覆盖第一次（装上摘不掉），所以
//    不能拆成独立测试文件各自 mock，只能单文件内做开关式透传。
let mockTodayOverride: string | null = null;
const realTime = { ...(await import("../../packages/libs/time")) };
mock.module("../../packages/libs/time", () => ({
  ...realTime,
  getTokyoDateKey: (date?: Date): string =>
    (mockTodayOverride === null || date ? realTime.getTokyoDateKey(date) : mockTodayOverride),
}));

const luckChallenge = await import("../../packages/commands/luckChallenge/index");
const cache = await import("../../packages/cache/main/luckChallenge");
const {
  DAILY_LUCK_CACHE_MAX,
  LUCK_TIERS,
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
} = await import("../../packages/consts/luckChallenge");
const { getTokyoDateKey } = await import("../../packages/libs/time");
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

function entitiesOf(result: any): any[] {
  return result.input_message_content.entities;
}

async function confirmResult(result: any): Promise<void> {
  await luckChallenge.confirmLuckDraw(bodyTextOf(result), entitiesOf(result));
}

function visibleBodyOf(result: any): string {
  return bodyTextOf(result).split("\n").slice(0, -1).join("\n");
}

describe("/luck_challenge 预览 -> 选中确认 -> 落盘 全链路", () => {
  beforeEach(() => {
    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    cache.recentCallTimestamps.clear();
    luckChallenge.restoreLuckState(TEST_SECRET, null);
    postDiskIOMock.mockClear();
    logApiErrorMock.mockClear();
    loggerErrorMock.mockClear();
    ensureLuckReceiptSecretMock.mockClear();
    ensureLuckReceiptSecretError = null;
  });

  test("普通内联回答失败只记录错误，不向 update handler 抛出", async () => {
    const error = new Error("query is too old");
    const ctx = {
      ...makeInlineCtx(101, ""),
      answerInlineQuery: async (): Promise<void> => { throw error; },
    };

    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    expect(logApiErrorMock).toHaveBeenCalledWith("answer luck inline query", error);
  });

  test("限流内联回答失败只记录错误，不向 update handler 抛出", async () => {
    const filledAt: number = Date.now();
    for (let filled: number = 0; filled < RATE_LIMIT_MAX_CALLS_PER_WINDOW; filled++) {
      cache.recentCallTimestamps.push(filledAt);
    }
    const error = new Error("query is too old");
    const ctx = {
      ...makeInlineCtx(102, ""),
      answerInlineQuery: async (): Promise<void> => { throw error; },
    };

    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    expect(logApiErrorMock).toHaveBeenCalledWith("answer rate-limited luck inline query", error);
  });

  test("刷新日缓存失败时，内联查询与选中确认都记录错误后返回", async () => {
    const error = new Error("disk I/O unavailable");
    ensureLuckReceiptSecretError = error;
    mockTodayOverride = "2030-01-02";
    try {
      const ctx = makeInlineCtx(103, "");
      await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
      await luckChallenge.handleLuckChosenInlineResult({
        chosenInlineResult: { result_id: "luck-fortune", from: { id: 103 }, query: "" },
      } as any);

      expect(ctx.results).toHaveLength(0);
      expect(logApiErrorMock).not.toHaveBeenCalled();
      expect(loggerErrorMock.mock.calls).toEqual([
        ["Failed to refresh luck cache for inline query:", error],
        ["Failed to refresh luck cache for chosen inline result:", error],
      ]);
    } finally {
      mockTodayOverride = null;
    }
  });

  test("普通多行文本和缺少实体的伪回执不触发跨日密钥刷新", async () => {
    mockTodayOverride = "2030-01-02";
    try {
      await luckChallenge.confirmLuckDraw("普通消息\n第二行也只是正文");
      await luckChallenge.confirmLuckDraw(`伪造消息\n防伪标记: ${"a".repeat(64)}`);

      expect(ensureLuckReceiptSecretMock).not.toHaveBeenCalled();
      expect(loggerErrorMock).not.toHaveBeenCalled();
      expect(postDiskIOMock).not.toHaveBeenCalled();
    } finally {
      mockTodayOverride = null;
    }
  });

  test("有效回执刷新日缓存失败时只记录错误，不阻断 update handler", async () => {
    const ctx = makeInlineCtx(104, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const error = new Error("disk I/O unavailable");
    ensureLuckReceiptSecretMock.mockClear();
    ensureLuckReceiptSecretError = error;
    mockTodayOverride = "2030-01-02";
    try {
      await luckChallenge.confirmLuckDraw(bodyTextOf(ctx.results[0]), entitiesOf(ctx.results[0]));

      expect(ensureLuckReceiptSecretMock).toHaveBeenCalledTimes(1);
      expect(ensureLuckReceiptSecretMock).toHaveBeenCalledWith("2030-01-02");
      expect(loggerErrorMock).toHaveBeenCalledWith(
        "Failed to refresh luck cache while confirming a luck receipt:",
        error
      );
      expect(postDiskIOMock).not.toHaveBeenCalled();
    } finally {
      mockTodayOverride = null;
    }
  });

  test("不带文本：带签名回执的结果现身后转正并 postDiskIO 落盘", async () => {
    const ctx = makeInlineCtx(111, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(2);

    const fortuneBody: string = bodyTextOf(ctx.results[0]);
    expect(fortuneBody.split("\n").at(-1)).toMatch(/^防伪标记: [a-f0-9]{64}$/);
    const spoiler = ctx.results[0].input_message_content.entities[0];
    expect(fortuneBody.slice(spoiler.offset, spoiler.offset + spoiler.length)).toMatch(/^[a-f0-9]{64}$/);
    const receiptLink = ctx.results[0].input_message_content.entities[1];
    expect(receiptLink).toMatchObject({
      type: "text_link",
      offset: spoiler.offset,
      length: spoiler.length,
    });
    expect(receiptLink.url.startsWith("https://t.me/#luck-receipt=luck:v1:")).toBe(true);
    await confirmResult(ctx.results[0]);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    const msg: any = postDiskIOMock.mock.calls[0]![0];
    expect(msg.type).toBe("luckDraw");
    expect(msg.key).toBe("111");
    expect(cache.dailyLuckCache.has("111")).toBe(true);
    expect(cache.pendingLuckDraws.has("111")).toBe(false);
  });

  test("旧版无「防伪标记」前缀的回执不再被确认", async () => {
    const ctx = makeInlineCtx(112, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    const lines: string[] = bodyTextOf(ctx.results[0]).split("\n");
    lines.pop();
    const receiptUrl: string = entitiesOf(ctx.results[0])[1]!.url;
    const legacyReceipt: string = receiptUrl.slice("https://t.me/#luck-receipt=".length);

    // 验签要求回执内嵌日期等于当天，日级密钥每天轮换：旧格式回执在展示标签
    // 格式上线次日起就已不可能验过，识别路径因此只保留当前格式。
    await luckChallenge.confirmLuckDraw(`${lines.join("\n")}\n${legacyReceipt}`);
    expect(postDiskIOMock).not.toHaveBeenCalled();
  });

  test("不带文本：选中「概率论」结果（同一把 key）也能确认落盘", async () => {
    const ctx = makeInlineCtx(222, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    await confirmResult(ctx.results[1]);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "222" });
    expect(cache.dailyLuckCache.has("222")).toBe(true);
  });

  test("带文本（所求事项）：选中结果 -> 用带冒号的 key 落盘", async () => {
    const ctx = makeInlineCtx(333, "今天适合表白吗");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    expect(ctx.results.length).toBe(1);

    await confirmResult(ctx.results[0]);

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

  test("同款问题按钮按字形簇截断，不拆开 ZWJ 组合表情", async () => {
    const question = "👨‍👩‍👧‍👦ABCD";
    const ctx = makeInlineCtx(8603940413, question);
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);

    const sameQuestionButton = ctx.results[0]!.reply_markup.inline_keyboard[0]![1]!;
    expect(sameQuestionButton.text).toBe("👨‍👩‍👧‍👦ABC...");
    expect(sameQuestionButton.switch_inline_query_current_chat).toBe(question);
  });

  test("同一天多个不同 key（多用户 / 同用户不同所求事项）各自独立落盘一次", async () => {
    const ctxA = makeInlineCtx(1, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxA as any);
    await confirmResult(ctxA.results[0]);

    const ctxB = makeInlineCtx(2, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxB as any);
    await confirmResult(ctxB.results[0]);

    const ctxC = makeInlineCtx(1, "工作运");
    await luckChallenge.handleLuckChallengeInlineQuery(ctxC as any);
    await confirmResult(ctxC.results[0]);

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
    // 调用方只传消息文本及其实体，不含（也拿不到）真实 uid。
    await confirmResult(ctx.results[0]);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(postDiskIOMock.mock.calls[0]![0]).toMatchObject({ type: "luckDraw", key: "888" });
    expect(cache.dailyLuckCache.has("888")).toBe(true);
  });

  test("当日已确认结果撑满上限后拒收新 key，也不再落盘", async () => {
    // key 是 `userId:sha256(问题原文)`，问题原文由用户随手输入——「当日唯一 key
    // 数」是攻击者选的数字而不是自然上界。不设闸的话，主线程这张 Map、Disk I/O
    // Worker 侧的当日镜像与 memory/luck/<day>.json 会一起整天长下去，而下次启动
    // 还要把整个文件逐条按 LUCK_TIERS 校验一遍才能开始收 update。
    const tier = LUCK_TIERS[0]!;
    for (let index: number = 0; index < DAILY_LUCK_CACHE_MAX; index++) {
      cache.dailyLuckCache.set(`filler:${index}`, { tier, fortunePercent: tier.fortunePercentRange[0] });
    }
    const ctx = makeInlineCtx(999, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
    postDiskIOMock.mockClear();

    await confirmResult(ctx.results[0]);

    // 撑满时连落盘消息都不投：那正是 Worker 侧镜像与当日文件无界增长的入口。
    expect(postDiskIOMock).not.toHaveBeenCalled();
    expect(cache.dailyLuckCache.has("999")).toBe(false);
    expect(cache.dailyLuckCache.size).toBe(DAILY_LUCK_CACHE_MAX);
    // 撑满只记一行，不逐条刷屏。
    expect(loggerErrorMock.mock.calls.filter(
      (call: unknown[]): boolean => String(call[0]).includes("Daily luck cache reached")
    )).toHaveLength(1);

    await confirmResult(ctx.results[0]);
    expect(loggerErrorMock.mock.calls.filter(
      (call: unknown[]): boolean => String(call[0]).includes("Daily luck cache reached")
    )).toHaveLength(1);
  });

  test("两个用户有独立自描述回执，可分别准确确认", async () => {
    const first = makeInlineCtx(881, "");
    const second = makeInlineCtx(882, "");
    await luckChallenge.handleLuckChallengeInlineQuery(first as any);
    await luckChallenge.handleLuckChallengeInlineQuery(second as any);
    const firstSignedBody: string = bodyTextOf(first.results[0]);
    const secondSignedBody: string = bodyTextOf(second.results[0]);
    expect(secondSignedBody).not.toBe(firstSignedBody);

    await confirmResult(first.results[0]);
    expect(cache.dailyLuckCache.has("881")).toBe(true);
    expect(cache.dailyLuckCache.has("882")).toBe(false);
    await confirmResult(second.results[0]);
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
    await luckChallenge.confirmLuckDraw(signedBody);
    const tamperedBody: string = `${signedBody.slice(0, -1)}${signedBody.endsWith("a") ? "b" : "a"}`;
    await luckChallenge.confirmLuckDraw(tamperedBody, entitiesOf(ctx.results[0]));
    expect(cache.dailyLuckCache.has("883")).toBe(false);
    expect(postDiskIOMock).not.toHaveBeenCalled();

    await confirmResult(ctx.results[0]);
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
    await luckChallenge.handleLuckChosenInlineResult({
      chosenInlineResult: { result_id: "luck-fortune", from: { id: 1001 }, query: "" },
    } as any);
    const confirmed = cache.dailyLuckCache.get("1001");
    await confirmResult(ctx.results[0]);

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
    const result = ctx.results[0];

    cache.dailyLuckCache.clear();
    cache.pendingLuckDraws.clear();
    luckChallenge.restoreLuckState(TEST_SECRET, null);
    await confirmResult(result);

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
    await confirmResult(ctx.results[0]);
    const confirmed = cache.dailyLuckCache.get("555");
    await confirmResult(ctx.results[0]);
    await confirmResult(ctx.results[0]);

    expect(postDiskIOMock).toHaveBeenCalledTimes(1);
    expect(cache.dailyLuckCache.size).toBe(1);
    expect(cache.dailyLuckCache.get("555")).toBe(confirmed!);
  });

  test("重新预览同一把 key 后再选中：同一天不会二次落盘/二次滚动", async () => {
    const ctx1 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx1 as any);
    await confirmResult(ctx1.results[0]);
    const confirmed = cache.dailyLuckCache.get("666");
    expect(postDiskIOMock).toHaveBeenCalledTimes(1);

    // 已确认之后用户又 @机器人 打了一遍字（重新触发 inline_query 预览）
    const ctx2 = makeInlineCtx(666, "");
    await luckChallenge.handleLuckChallengeInlineQuery(ctx2 as any);
    expect(visibleBodyOf(ctx2.results[0])).toBe(visibleBodyOf(ctx1.results[0]));
    await confirmResult(ctx2.results[0]);

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

  // 必须是本文件最后一个测试：进程内跨天会永久置位 cache.ts 的
  // daySwitchedInProcess，此后 pending 未命中的确认一律 fail closed，会改变
  // 前面依赖「重启后重建派生」的测试的行为。
  test("进程内跨东京零点后：迟到确认 fail closed，当天新流程与带当日证明的回执不受影响", async () => {
    const luckDrawCalls = (): unknown[] =>
      postDiskIOMock.mock.calls.filter((call) => (call[0] as { type?: string }).type === "luckDraw");
    try {
      mockTodayOverride = "2030-01-01";
      luckChallenge.restoreLuckState(
        { version: 1 as const, day: "2030-01-01", key: TEST_SECRET.key },
        null
      );

      // 1 月 1 日深夜的预览：结果进 pending，用户尚未确认。
      const ctx = makeInlineCtx(111, "");
      await luckChallenge.handleLuckChallengeInlineQuery(ctx as any);
      expect(cache.pendingLuckDraws.has("111")).toBe(true);
      const oldResult = ctx.results[0];
      postDiskIOMock.mockClear();

      // 东京零点翻页：下一次确认路径进入时整体切换日缓存、清空 pending。
      mockTodayOverride = "2030-01-02";
      const registration: unknown[] = onDiskIORespawnMock.mock.calls[0]!;
      expect(registration[0]).toBe("daily luck");
      expect(registration[1]).toBe(400);
      const respawnListener = registration[2] as (transport: {
        post(message: unknown): boolean;
        ensureLuckReceiptSecret(day: string): Promise<typeof TEST_SECRET>;
      }) => Promise<boolean>;
      const recoverySecretDays: string[] = [];
      const recoveryPosts: unknown[] = [];
      expect(await respawnListener({
        post: (message: unknown): boolean => {
          recoveryPosts.push(message);
          return true;
        },
        ensureLuckReceiptSecret: async (day: string): Promise<typeof TEST_SECRET> => {
          recoverySecretDays.push(day);
          return { ...TEST_SECRET, day };
        },
      })).toBeTrue();
      expect(recoverySecretDays).toEqual(["2030-01-02"]);
      expect(recoveryPosts).toEqual([]);
      expect(cache.pendingLuckDraws.size).toBe(0);

      // 迟到的 chosen 回执没有任何日期证明：不得用新一天的密钥重派生落盘。
      await luckChallenge.handleLuckChosenInlineResult({
        chosenInlineResult: { result_id: "luck-fortune", from: { id: 111 }, query: "" },
      } as any);
      expect(luckDrawCalls()).toHaveLength(0);
      expect(cache.dailyLuckCache.size).toBe(0);

      // 迟到的签名回执带着 1 月 1 日的日期与签名，在 1 月 2 日验签失败，同样丢弃。
      await confirmResult(oldResult);
      expect(luckDrawCalls()).toHaveLength(0);
      expect(cache.dailyLuckCache.size).toBe(0);

      // 新的一天里正常的预览 -> 选中链路照常确认落盘（pending 命中路径）。
      const todayCtx = makeInlineCtx(222, "");
      await luckChallenge.handleLuckChallengeInlineQuery(todayCtx as any);
      await luckChallenge.handleLuckChosenInlineResult({
        chosenInlineResult: { result_id: "luck-fortune", from: { id: 222 }, query: "" },
      } as any);
      expect(cache.dailyLuckCache.has("222")).toBe(true);
      expect(luckDrawCalls()).toHaveLength(1);

      // 跨天后同日的回执确认自带当日证明：pending 即便丢失也允许重建派生。
      const receiptCtx = makeInlineCtx(333, "");
      await luckChallenge.handleLuckChallengeInlineQuery(receiptCtx as any);
      cache.pendingLuckDraws.clear();
      await confirmResult(receiptCtx.results[0]);
      expect(cache.dailyLuckCache.has("333")).toBe(true);
      expect(luckDrawCalls()).toHaveLength(2);
    } finally {
      mockTodayOverride = null;
    }
  });
});
