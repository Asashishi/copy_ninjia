import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../packages/consts/bot";
import { botAtmosphereState } from "../../packages/cache/main/atmosphere";
import { atmosphereState as aiAtmosphere, resetAiChatIdentityCache } from "../../packages/cache/workers/aiChat/identity";
import { atmosphereState as raidAtmosphere } from "../../packages/cache/workers/antiRaid/atmosphere";
import { aiChatAtmosphere } from "../../packages/workers/aiChat/atmosphere";
import { workerAtmosphere } from "../../packages/workers/antiRaid/atmosphere";
import type { Atmosphere } from "../../packages/types/atmosphere";
import type { Context } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { LUCK_TIERS, RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../packages/consts/luckChallenge";
import { getDateKey } from "../../packages/libs/time";
import { dailyLuckCache, luckCacheState, luckReceiptSecretState, recentCallTimestamps } from "../../packages/cache/main/luckChallenge";
import { chatAtmosphere } from "../../packages/infra/atmosphere";
import { registerCommandMenu } from "../../packages/app/commandMenu";
import { handleLuckChallengeInlineQuery } from "../../packages/commands/luckChallenge/telegramAdapter";

// 本组使用启动总闸已确定的普通通知风格；跑完还原 preload 接管的值。
const PRELOADED_ATMOSPHERE: Atmosphere | null = botAtmosphereState.current;
botAtmosphereState.current = "plain";

afterEach(() => {
  botAtmosphereState.current = "plain";
  resetAiChatIdentityCache();
  raidAtmosphere.current = null;
  dailyLuckCache.clear();
  luckCacheState.dayKey = "";
  luckReceiptSecretState.current = null;
  recentCallTimestamps.clear();
});
afterAll(() => { botAtmosphereState.current = PRELOADED_ATMOSPHERE; });

test("inline 运势的称呼、评语和限频提示使用本进程普通语气", async (): Promise<void> => {
  const day: string = getDateKey();
  luckCacheState.dayKey = day;
  luckReceiptSecretState.current = {
    version: 1,
    day,
    key: new Uint8Array(32).fill(7).toBase64({ alphabet: "base64url", omitPadding: true }),
  };
  dailyLuckCache.set("101", { tier: LUCK_TIERS[0]!, fortunePercent: 90 });
  const results: InlineQueryResultArticle[] = [];
  const ctx: Context = {
    inlineQuery: { from: { id: 101, first_name: "" }, query: "" },
    answerInlineQuery: async (articles: InlineQueryResultArticle[]): Promise<void> => { results.push(...articles); },
  } as unknown as Context;
  await handleLuckChallengeInlineQuery(ctx);
  expect(results).toHaveLength(2);
  const content: InlineQueryResultArticle["input_message_content"] = results[0]!.input_message_content;
  expect(content).toHaveProperty("message_text", expect.stringContaining(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.unknownUser));
  expect(content).toHaveProperty("message_text", expect.stringContaining(ATMOSPHERE_TEXTS.plain.LUCK_TIER_COMMENTS.大吉));
  for (let index: number = 1; index < RATE_LIMIT_MAX_CALLS_PER_WINDOW; index++) recentCallTimestamps.push(Date.now());
  results.length = 0;
  await handleLuckChallengeInlineQuery(ctx);
  expect(results).toHaveLength(1);
  expect(results[0]!.title).toBe(ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.inlineRateLimitTitle);
});

test("普通风格下主线程文案与全群命令菜单一致，不再注册单群作用域", async () => {
  expect(chatAtmosphere()).toBe(ATMOSPHERE_TEXTS.plain);
  const setMyCommands = mock(async (): Promise<true> => true);
  const deleteMyCommands = mock(async (): Promise<true> => true);
  await registerCommandMenu({ api: { setMyCommands, deleteMyCommands } } as never);
  expect(setMyCommands).toHaveBeenCalledTimes(1);
  expect(setMyCommands).toHaveBeenCalledWith(ATMOSPHERE_TEXTS.plain.BOT_COMMANDS, { scope: { type: "all_group_chats" } });
  expect(deleteMyCommands).toHaveBeenCalledTimes(1);
  expect(deleteMyCommands).toHaveBeenCalledWith();
});

test("两个 Worker 读取初始化载荷注入的本进程风格，未注入时使用配置缺省风格", () => {
  for (const style of ["teasing", "plain"] as readonly Atmosphere[]) {
    aiAtmosphere.current = style;
    raidAtmosphere.current = style;
    expect(aiChatAtmosphere()).toBe(ATMOSPHERE_TEXTS[style]);
    expect(workerAtmosphere()).toBe(ATMOSPHERE_TEXTS[style]);
  }
  aiAtmosphere.current = null;
  raidAtmosphere.current = null;
  expect(aiChatAtmosphere()).toBe(ATMOSPHERE_TEXTS[BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]]);
  expect(workerAtmosphere()).toBe(ATMOSPHERE_TEXTS[BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]]);
});
